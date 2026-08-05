-- ============================================================================
-- CHAT MODULE V1 - EPHEMERAL CONVERSATION SYSTEM (SUPABASE SQL MIGRATION)
-- ============================================================================

-- 1. DROP EXISTING TABLES AND FUNCTIONS IF EXISTS
DROP FUNCTION IF EXISTS public.chat_cleanup_expired();
DROP FUNCTION IF EXISTS public.chat_close_request(UUID);
DROP FUNCTION IF EXISTS public.chat_mark_opened(UUID);
DROP FUNCTION IF EXISTS public.chat_get_messages(UUID);
DROP FUNCTION IF EXISTS public.chat_get_conversations();
DROP FUNCTION IF EXISTS public.chat_send_message(UUID, TEXT);
DROP FUNCTION IF EXISTS public.chat_get_or_create_conversation(UUID);

DROP TABLE IF EXISTS public.chat_messages CASCADE;
DROP TABLE IF EXISTS public.chat_participants CASCADE;
DROP TABLE IF EXISTS public.chat_conversations CASCADE;

-- 2. CREATE TABLE: chat_conversations
CREATE TABLE public.chat_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL CHECK (type IN ('friend', 'request')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'opened', 'closed')),
    created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);

-- Index for performance
CREATE INDEX idx_chat_conversations_type ON public.chat_conversations(type);
CREATE INDEX idx_chat_conversations_status ON public.chat_conversations(status);
CREATE INDEX idx_chat_conversations_expires_at ON public.chat_conversations(expires_at);

-- 3. CREATE TABLE: chat_participants
CREATE TABLE public.chat_participants (
    conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_message_id UUID,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_chat_participants_user_id ON public.chat_participants(user_id);

-- 4. CREATE TABLE: chat_messages
CREATE TABLE public.chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'system')),
    content TEXT,
    ciphertext TEXT,
    iv TEXT,
    algorithm TEXT DEFAULT 'AES-GCM',
    key_version INT DEFAULT 1,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);

ALTER TABLE public.chat_conversations ADD COLUMN IF NOT EXISTS key_salt TEXT;
ALTER TABLE public.chat_messages ALTER COLUMN content DROP NOT NULL;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS ciphertext TEXT;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS iv TEXT;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS algorithm TEXT DEFAULT 'AES-GCM';
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS key_version INT DEFAULT 1;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX idx_chat_messages_conversation ON public.chat_messages(conversation_id, created_at ASC);

-- Enable RLS & Realtime
ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;

-- Basic RLS Policies
CREATE POLICY "Users can access their conversations" ON public.chat_conversations
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.chat_participants
            WHERE conversation_id = public.chat_conversations.id
            AND user_id = auth.uid()
        )
    );

CREATE POLICY "Users can view participants" ON public.chat_participants
    FOR ALL USING (user_id = auth.uid() OR EXISTS (
        SELECT 1 FROM public.chat_participants p2
        WHERE p2.conversation_id = public.chat_participants.conversation_id
        AND p2.user_id = auth.uid()
    ));

CREATE POLICY "Users can view messages in their conversations" ON public.chat_messages
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.chat_participants
            WHERE conversation_id = public.chat_messages.conversation_id
            AND user_id = auth.uid()
        )
    );

-- Add chat_messages to Supabase Realtime Publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_conversations;

-- ============================================================================
-- RPC FUNCTIONS
-- ============================================================================

-- 1. chat_get_or_create_conversation
CREATE OR REPLACE FUNCTION public.chat_get_or_create_conversation(p_target_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_is_friends BOOLEAN := false;
    v_conv_id UUID;
    v_conv_record RECORD;
    v_conv_type TEXT;
    v_existing_id UUID;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;
    IF v_user_id = p_target_id THEN
        RAISE EXCEPTION 'Cannot start a chat conversation with yourself.';
    END IF;

    -- Check Relationship via existing friends table
    SELECT EXISTS (
        SELECT 1 FROM public.friends
        WHERE (user_id = v_user_id AND friend_id = p_target_id)
           OR (user_id = p_target_id AND friend_id = v_user_id)
    ) INTO v_is_friends;

    v_conv_type := CASE WHEN v_is_friends THEN 'friend' ELSE 'request' END;

    -- Check if active non-deleted conversation already exists between the two users
    SELECT c.id INTO v_existing_id
    FROM public.chat_conversations c
    JOIN public.chat_participants p1 ON p1.conversation_id = c.id AND p1.user_id = v_user_id
    JOIN public.chat_participants p2 ON p2.conversation_id = c.id AND p2.user_id = p_target_id
    WHERE c.deleted_at IS NULL
      AND c.type = v_conv_type
      AND c.status != 'closed'
    ORDER BY c.updated_at DESC
    LIMIT 1;

    -- If no existing conversation found
    IF v_existing_id IS NULL THEN
        -- If request chat, enforce max 1 active request per pair
        IF v_conv_type = 'request' THEN
            SELECT c.id INTO v_existing_id
            FROM public.chat_conversations c
            JOIN public.chat_participants p1 ON p1.conversation_id = c.id AND p1.user_id = v_user_id
            JOIN public.chat_participants p2 ON p2.conversation_id = c.id AND p2.user_id = p_target_id
            WHERE c.deleted_at IS NULL AND c.type = 'request'
            LIMIT 1;

            IF v_existing_id IS NOT NULL THEN
                SELECT id, type, status, created_by, created_at, updated_at, last_message_at, expires_at, opened_at
                INTO v_conv_record
                FROM public.chat_conversations WHERE id = v_existing_id;

                RETURN jsonb_build_object(
                    'success', true,
                    'conversation', to_jsonb(v_conv_record),
                    'is_new', false,
                    'message', 'Retrieved existing chat request.'
                );
            END IF;
        END IF;

        -- Create new conversation
        INSERT INTO public.chat_conversations (
            type, status, created_by, created_at, updated_at, last_message_at, expires_at
        ) VALUES (
            v_conv_type,
            'pending',
            v_user_id,
            now(),
            now(),
            now(),
            CASE WHEN v_conv_type = 'friend' THEN now() + INTERVAL '24 hours' ELSE NULL END
        ) RETURNING id INTO v_conv_id;

        -- Add participants
        INSERT INTO public.chat_participants (conversation_id, user_id) VALUES
        (v_conv_id, v_user_id),
        (v_conv_id, p_target_id);

        SELECT id, type, status, created_by, created_at, updated_at, last_message_at, expires_at, opened_at
        INTO v_conv_record
        FROM public.chat_conversations WHERE id = v_conv_id;

        RETURN jsonb_build_object(
            'success', true,
            'conversation', to_jsonb(v_conv_record),
            'is_new', true,
            'message', 'Created new ' || v_conv_type || ' conversation.'
        );
    ELSE
        SELECT id, type, status, created_by, created_at, updated_at, last_message_at, expires_at, opened_at
        INTO v_conv_record
        FROM public.chat_conversations WHERE id = v_existing_id;

        RETURN jsonb_build_object(
            'success', true,
            'conversation', to_jsonb(v_conv_record),
            'is_new', false,
            'message', 'Retrieved existing ' || v_conv_type || ' conversation.'
        );
    END IF;
END;
$$;

-- 2. chat_send_message
CREATE OR REPLACE FUNCTION public.chat_send_message(
    p_conversation_id UUID,
    p_content TEXT DEFAULT NULL,
    p_ciphertext TEXT DEFAULT NULL,
    p_iv TEXT DEFAULT NULL,
    p_algorithm TEXT DEFAULT 'AES-GCM',
    p_key_version INT DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_msg_id UUID;
    v_msg_record RECORD;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    IF (p_content IS NULL OR trim(p_content) = '') AND (p_ciphertext IS NULL OR trim(p_ciphertext) = '') THEN
        RAISE EXCEPTION 'Message content or ciphertext must be provided.';
    END IF;

    -- Check participant
    IF NOT EXISTS (
        SELECT 1 FROM public.chat_participants
        WHERE conversation_id = p_conversation_id AND user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'You are not a participant in this conversation.';
    END IF;

    -- Insert message (supports both encrypted ciphertext and legacy content)
    INSERT INTO public.chat_messages (conversation_id, sender_id, type, content, ciphertext, iv, algorithm, key_version, created_at)
    VALUES (p_conversation_id, v_user_id, 'text', p_content, p_ciphertext, p_iv, p_algorithm, p_key_version, now())
    RETURNING id INTO v_msg_id;

    -- Update conversation timers & last_message_at
    UPDATE public.chat_conversations
    SET last_message_at = now(),
        updated_at = now(),
        expires_at = CASE WHEN type = 'friend' THEN now() + INTERVAL '24 hours' ELSE expires_at END
    WHERE id = p_conversation_id;

    SELECT id, conversation_id, sender_id, type, content, ciphertext, iv, algorithm, key_version, metadata, created_at
    INTO v_msg_record
    FROM public.chat_messages WHERE id = v_msg_id;

    RETURN jsonb_build_object(
        'success', true,
        'message', to_jsonb(v_msg_record)
    );
END;
$$;

-- 3. chat_get_conversations
CREATE OR REPLACE FUNCTION public.chat_get_conversations()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_friends JSONB;
    v_requests JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- Perform auto cleanup of expired chats first
    PERFORM public.chat_cleanup_expired();

    -- Fetch Friend Conversations
    SELECT coalesce(jsonb_agg(conv_data), '[]'::jsonb) INTO v_friends
    FROM (
        SELECT 
            c.id,
            c.type,
            c.status,
            c.created_by,
            c.created_at,
            c.updated_at,
            c.last_message_at,
            c.expires_at,
            c.opened_at,
            to_jsonb(p) AS other_user,
            (
                SELECT to_jsonb(m.*) FROM public.chat_messages m 
                WHERE m.conversation_id = c.id AND m.deleted_at IS NULL 
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message,
            (
                SELECT count(*)::int FROM public.chat_messages m 
                WHERE m.conversation_id = c.id 
                AND m.deleted_at IS NULL 
                AND m.sender_id != v_user_id 
                AND m.is_read = false
            ) AS unread_count
        FROM public.chat_conversations c
        JOIN public.chat_participants cp ON cp.conversation_id = c.id AND cp.user_id = v_user_id
        JOIN public.chat_participants cp_other ON cp_other.conversation_id = c.id AND cp_other.user_id != v_user_id
        JOIN public.profiles p ON p.id = cp_other.user_id
        WHERE c.deleted_at IS NULL
          AND c.type = 'friend'
        ORDER BY c.last_message_at DESC
    ) conv_data;

    -- Fetch Request Conversations
    SELECT coalesce(jsonb_agg(conv_data), '[]'::jsonb) INTO v_requests
    FROM (
        SELECT 
            c.id,
            c.type,
            c.status,
            c.created_by,
            c.created_at,
            c.updated_at,
            c.last_message_at,
            c.expires_at,
            c.opened_at,
            to_jsonb(p) AS other_user,
            (
                SELECT to_jsonb(m.*) FROM public.chat_messages m 
                WHERE m.conversation_id = c.id AND m.deleted_at IS NULL 
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message,
            (
                SELECT count(*)::int FROM public.chat_messages m 
                WHERE m.conversation_id = c.id 
                AND m.deleted_at IS NULL 
                AND m.sender_id != v_user_id 
                AND m.is_read = false
            ) AS unread_count
        FROM public.chat_conversations c
        JOIN public.chat_participants cp ON cp.conversation_id = c.id AND cp.user_id = v_user_id
        JOIN public.chat_participants cp_other ON cp_other.conversation_id = c.id AND cp_other.user_id != v_user_id
        JOIN public.profiles p ON p.id = cp_other.user_id
        WHERE c.deleted_at IS NULL
          AND c.type = 'request'
        ORDER BY c.last_message_at DESC
    ) conv_data;

    RETURN jsonb_build_object(
        'success', true,
        'friends', v_friends,
        'requests', v_requests
    );
END;
$$;

-- 4. chat_get_messages
CREATE OR REPLACE FUNCTION public.chat_get_messages(p_conversation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_messages JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- Check participant
    IF NOT EXISTS (
        SELECT 1 FROM public.chat_participants
        WHERE conversation_id = p_conversation_id AND user_id = v_user_id
    ) THEN
        RAISE EXCEPTION 'You are not a participant in this conversation.';
    END IF;

    -- Mark unread messages as read for this user
    UPDATE public.chat_messages
    SET is_read = true
    WHERE conversation_id = p_conversation_id
      AND sender_id != v_user_id
      AND is_read = false;

    SELECT coalesce(jsonb_agg(m_data), '[]'::jsonb) INTO v_messages
    FROM (
        SELECT m.id, m.conversation_id, m.sender_id, m.type, m.content, m.ciphertext, m.iv, m.algorithm, m.key_version, m.metadata, m.created_at, m.edited_at, m.is_read,
               to_jsonb(p) AS sender
        FROM public.chat_messages m
        JOIN public.profiles p ON p.id = m.sender_id
        WHERE m.conversation_id = p_conversation_id
          AND m.deleted_at IS NULL
        ORDER BY m.created_at ASC
    ) m_data;

    RETURN jsonb_build_object(
        'success', true,
        'messages', v_messages
    );
END;
$$;

-- 5. chat_mark_opened
CREATE OR REPLACE FUNCTION public.chat_mark_opened(p_conversation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- Update only for request conversations where user is recipient
    UPDATE public.chat_conversations
    SET opened_at = coalesce(opened_at, now()),
        status = 'opened',
        updated_at = now()
    WHERE id = p_conversation_id
      AND type = 'request'
      AND created_by != v_user_id
      AND deleted_at IS NULL;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- 6. chat_close_request
CREATE OR REPLACE FUNCTION public.chat_close_request(p_conversation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    -- Soft delete conversation if request was opened and closed by recipient, or cancelled by sender
    UPDATE public.chat_conversations
    SET deleted_at = now(),
        status = 'closed',
        updated_at = now()
    WHERE id = p_conversation_id
      AND type = 'request'
      AND deleted_at IS NULL
      AND (
        (created_by != v_user_id AND opened_at IS NOT NULL) OR
        (created_by = v_user_id)
      );

    -- Run auto cleanup
    PERFORM public.chat_cleanup_expired();

    RETURN jsonb_build_object('success', true);
END;
$$;

-- 7. chat_cleanup_expired
CREATE OR REPLACE FUNCTION public.chat_cleanup_expired()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Permanently delete soft-deleted messages
    DELETE FROM public.chat_messages WHERE deleted_at IS NOT NULL;

    -- Permanently delete expired friend conversations (> 24h inactivity)
    DELETE FROM public.chat_conversations
    WHERE (type = 'friend' AND expires_at IS NOT NULL AND expires_at < now())
       OR (deleted_at IS NOT NULL);
END;
$$;
