async function checkSession() {
    try {
        const {
            data: { session },
            error
        } = await supabaseClient.auth.getSession();

        if (error) {
            console.error("Error getting session from Supabase:", error);
            if (!app.state.user?.isGuest) app.state.user = null;
            app.syncAuthStateDisplay();
            return;
        }

        if (!session || !session.user) {
            if (!app.state.user?.isGuest) app.state.user = null;
            app.syncAuthStateDisplay();
            return;
        }

        // Valid session exists -> process session restoration silently
        await app.processSessionUser(session.user, false);
    } catch (err) {
        console.error("Error checking session:", err);
    }
}

const app = {
    // ======================== STATE ========================
    state: {
        user: JSON.parse(localStorage.getItem('kt_user')) || null,
        pendingGoogleAuth: null,
        history: JSON.parse(localStorage.getItem('kt_history')) || [],
        activeTest: null,
        timer: null,
        timeLeft: 0,
        metrics: { totalAnswered: 0, correctAnswers: 0, seriesScores: [] },
        currentSumTarget: 0,
        isTestRunning: false,
        isRegistering: false,
        unverifiedEmail: null,
        pendingRegistrationUsername: null,
        resendCooldownSeconds: 0,
        resendInterval: null,
        verifyPageCooldownSeconds: 0,
        verifyPageCooldownInterval: null,
        verificationPollingInterval: null,
        isEmailVerificationSuccess: false,
        currentView: 'home',
        isInternalHashChange: false,
        isResendingVerification: false,
        forgotResendCooldownSeconds: 0,
        forgotResendInterval: null,
        isRecoverySession: false,
        isChangingPassword: false,
        escChangePasswordHandler: null,
        announcementDismissed: JSON.parse(localStorage.getItem('kt_announcement_dismissed')) || false,
        historyChart: null
    },

    /**
     * CONSISTENCY CALCULATION ENGINE
     * Measures stability of user performance across 20-second segments.
     * Dynamic segment generation based on total duration (duration / 20).
     * Calculates standard deviation of segment scores normalized to 0 - 100.
     * - 100 = extremely stable performance
     * - 0 = extremely unstable performance
     */
    calculateConsistency(seriesScores) {
        if (!seriesScores || seriesScores.length <= 1) return 100;
        const mean = seriesScores.reduce((a, b) => a + b, 0) / seriesScores.length;
        if (mean === 0) return 0;

        // Variance & Standard Deviation calculation
        const variance = seriesScores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / seriesScores.length;
        const stdDev = Math.sqrt(variance);

        // Standardized Coefficient of Variation (relative variation)
        const relativeVariation = stdDev / mean;
        const consistency = Math.max(0, Math.min(100, Math.round(100 * (1 - Math.min(1, relativeVariation)))));
        return consistency;
    },

    validateUsername(username) {
        if (!username || username.trim() === '') {
            return { valid: false, message: 'Username cannot be empty.' };
        }
        const cleaned = username.trim().toLowerCase();

        // Reserved usernames list
        const reserved = [
            'admin', 'administrator', 'owner', 'moderator', 'support',
            'system', 'api', 'root', 'guest', 'test', 'null', 'undefined'
        ];
        if (reserved.includes(cleaned)) {
            return { valid: false, message: 'This username is reserved and cannot be used.' };
        }

        if (cleaned.length < 3) {
            return { valid: false, message: 'Username must be at least 3 characters.' };
        }
        if (cleaned.length > 20) {
            return { valid: false, message: 'Username cannot exceed 20 characters.' };
        }
        if (!/^[a-z0-9_]+$/.test(cleaned)) {
            return { valid: false, message: 'Username may only contain lowercase letters (a-z), numbers (0-9), and underscores (_).' };
        }
        if (cleaned.startsWith('_') || cleaned.endsWith('_')) {
            return { valid: false, message: 'Username cannot start or end with an underscore (_).' };
        }
        return { valid: true, value: cleaned };
    },

    validateDisplayName(displayName) {
        if (!displayName || displayName.trim() === '') {
            return { valid: true, value: null };
        }
        const cleaned = displayName.trim();
        if (cleaned.length > 50) {
            return { valid: false, message: 'Display Name cannot exceed 50 characters.' };
        }
        return { valid: true, value: cleaned };
    },

    validateBio(bio) {
        if (!bio || bio.trim() === '') return { valid: true, value: null };
        const cleaned = bio.trim();
        if (cleaned.length > 160) {
            return { valid: false, message: 'Bio cannot exceed 160 characters.' };
        }
        return { valid: true, value: cleaned };
    },

    escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    getTimeBasedGreeting() {
        const hour = new Date().getHours();
        if (hour >= 5 && hour < 12) return 'Good morning,';
        if (hour >= 12 && hour < 17) return 'Good afternoon,';
        if (hour >= 17 && hour < 21) return 'Good evening,';
        return 'Good night,';
    },

    getEffectiveDisplayName(user) {
        if (!user) return 'Guest User';
        if (user.displayName && user.displayName.trim() !== '') {
            return user.displayName.trim();
        }
        if (user.username && user.username.trim() !== '') {
            return user.username.trim();
        }
        if (user.name && user.name.trim() !== '') {
            return user.name.trim();
        }
        if (user.email) {
            return user.email.split('@')[0];
        }
        return 'User';
    },

    renderAvatar(elementId, user) {
        const el = document.getElementById(elementId);
        if (!el) return;

        const avatarUrl = user?.avatarUrl || user?.avatar_url || null;
        const effectiveName = this.getEffectiveDisplayName(user);
        const letter = (effectiveName && effectiveName.length > 0) ? effectiveName.charAt(0).toUpperCase() : '?';

        if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.trim() !== '' &&
            (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://') || avatarUrl.startsWith('data:image/'))) {
            const safeUrl = this.escapeHtml(avatarUrl.trim());
            el.innerHTML = `<img src="${safeUrl}" alt="Avatar" class="w-full h-full object-cover rounded-full">`;
        } else {
            el.innerText = letter;
        }
    },

    convertImageToJpgBlob(file, quality = 0.90) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);

            img.onload = () => {
                URL.revokeObjectURL(objectUrl);

                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;

                const ctx = canvas.getContext('2d');
                // Fill white background for transparent PNG/WebP images
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Failed to convert image to JPG.'));
                    }
                }, 'image/jpeg', quality);
            };

            img.onerror = (err) => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('Failed to read image file.'));
            };

            img.src = objectUrl;
        });
    },

    async fetchUserProfile(userId, email) {
        let username = email ? email.split('@')[0] : 'user';
        let displayName = null;
        let bio = null;
        let avatarUrl = null;
        let usernameLastChanged = null;
        let bestStandardScore = null;
        let bestStandardAccuracy = null;
        let bestStandardConsistency = null;
        let bestStandardTestDate = null;
        let lastNotifiedRank = null;
        let profile = null;

        try {
            const { data } = await supabaseClient
                .from('profiles')
                .select('*')
                .eq('id', userId)
                .maybeSingle();

            profile = data;

            if (profile) {
                console.log('[SHOWCASE PROFILE]', profile.achievement_showcase);
                username = profile.username || username;
                displayName = profile.display_name || null;
                bio = profile.bio || null;
                avatarUrl = profile.avatar_url || null;
                usernameLastChanged = profile.username_changed_at || null;
                bestStandardScore = profile.best_standard_score != null ? profile.best_standard_score : null;
                bestStandardAccuracy = profile.best_standard_accuracy != null ? profile.best_standard_accuracy : null;
                bestStandardConsistency = profile.best_standard_consistency != null ? profile.best_standard_consistency : null;
                bestStandardTestDate = profile.best_standard_test_date || null;
                lastNotifiedRank = profile.last_notified_rank !== undefined ? profile.last_notified_rank : null;
            }
        } catch (e) {
            console.error('Error fetching profile from Supabase:', e);
        }

        const userObj = {
            id: userId,
            username: username,
            displayName: displayName,
            name: displayName || username,
            email: email,
            bio: bio,
            avatarUrl: avatarUrl,
            avatar_url: avatarUrl,
            usernameLastChanged: usernameLastChanged,
            best_standard_score: bestStandardScore,
            best_standard_accuracy: bestStandardAccuracy,
            best_standard_consistency: bestStandardConsistency,
            best_standard_test_date: bestStandardTestDate,
            last_notified_rank: lastNotifiedRank,
            achievement_showcase: profile?.achievement_showcase || null,
            isGuest: false
        };

        console.log('[SHOWCASE STATE]', userObj.achievement_showcase);
        return userObj;
    },

    async processSessionUser(authUser, isFreshLogin = false) {
        // Skip processing if a manual email registration is in progress
        if (app.state.isRegistering) {
            console.log('[AUTH] Skipping processSessionUser — registration in progress');
            return;
        }

        const isExplicitGoogleLogin = sessionStorage.getItem('kt_google_login_pending') === 'true' || window.location.hash.includes('access_token=');
        const isExplicitLogin = isFreshLogin || isExplicitGoogleLogin;

        if (isExplicitLogin) {
            console.log('[AUTH] Fresh Login');
        } else {
            console.log('[AUTH] Session Restore');
        }

        console.log('[GOOGLE SESSION RESTORED]');
        console.log('[GOOGLE EMAIL VERIFIED]', authUser.email);

        const authId = authUser.id;
        const authEmail = authUser.email;

        // Fetch profile by ID first (primary), then fallback to email
        let profile = null;
        try {
            const { data, error } = await supabaseClient
                .from('profiles')
                .select('*')
                .eq('id', authId)
                .maybeSingle();

            if (error) {
                console.error('Error fetching profile by id:', error);
            } else {
                profile = data;
            }

            // Fallback: try by email if not found by id
            if (!profile) {
                const { data: emailData, error: emailError } = await supabaseClient
                    .from('profiles')
                    .select('*')
                    .eq('email', authEmail)
                    .maybeSingle();

                if (emailError) {
                    console.error('Error fetching profile by email:', emailError);
                } else {
                    profile = emailData;
                }
            }
        } catch (e) {
            console.error('Error profile lookup:', e);
        }

        console.log('[PROFILE] Profile fetched', profile ? 'found' : 'not found');

        if (profile) {
            // Check if username is genuinely missing
            const hasValidUsername = profile.username && profile.username.trim() !== '';
            console.log('[PROFILE] Username:', profile.username || '(empty)');

            if (!hasValidUsername && isExplicitGoogleLogin) {
                // Profile exists but username is missing — Google user needs onboarding
                console.log('[NAVIGATION] Choose Username (Google user, username missing)');
                app.state.user = null;
                app.state.pendingGoogleAuth = {
                    id: authId,
                    email: authEmail
                };
                app.syncAuthStateDisplay();
                app.navigate('onboarding');
                return;
            }

            // CASE 1: Profile exists with valid username
            console.log('[GOOGLE PROFILE FOUND]');
            console.log('[SHOWCASE PROFILE]', profile.achievement_showcase);
            app.state.pendingGoogleAuth = null;
            app.state.user = {
                id: profile.id,
                username: profile.username || authEmail.split('@')[0],
                displayName: profile.display_name || null,
                name: profile.display_name || profile.username || authEmail.split('@')[0],
                email: profile.email || authEmail,
                bio: profile.bio || null,
                avatarUrl: profile.avatar_url || null,
                avatar_url: profile.avatar_url || null,
                usernameLastChanged: profile.username_changed_at || null,
                best_standard_score: profile.best_standard_score != null ? profile.best_standard_score : null,
                best_standard_accuracy: profile.best_standard_accuracy != null ? profile.best_standard_accuracy : null,
                best_standard_consistency: profile.best_standard_consistency != null ? profile.best_standard_consistency : null,
                best_standard_test_date: profile.best_standard_test_date || null,
                last_notified_rank: profile.last_notified_rank !== undefined ? profile.last_notified_rank : null,
                achievement_showcase: profile.achievement_showcase || null,
                isGuest: false
            };
            console.log('[SHOWCASE STATE]', app.state.user.achievement_showcase);
            localStorage.setItem('kt_user', JSON.stringify(app.state.user));
            console.log('[GOOGLE LOGIN SUCCESS]');
            app.syncAuthStateDisplay();

            if (isExplicitLogin) {
                sessionStorage.removeItem('kt_google_login_pending');
                app.toast.show('Login successful!', 'success');
                console.log('[NAVIGATION] Dashboard');
                app.navigate('dashboard');
            }
        } else {
            // CASE 2: Profile does NOT exist
            if (isExplicitGoogleLogin) {
                // Google user with no profile at all — needs onboarding
                console.log('[GOOGLE PROFILE NOT FOUND]');
                console.log('[GOOGLE USERNAME REQUIRED]');
                console.log('[NAVIGATION] Choose Username (Google user, no profile)');
                app.state.user = null;
                app.state.pendingGoogleAuth = {
                    id: authId,
                    email: authEmail
                };
                app.syncAuthStateDisplay();
                app.navigate('onboarding');
            } else {
                // Non-Google user with no profile (edge case) — do not redirect to onboarding
                console.log('[PROFILE] No profile found for non-Google user, skipping onboarding redirect');
            }
        }
    },

    updateRegisterSubmitState() {
        const btn = document.getElementById('btn-register-submit');
        if (!btn) return;

        const isUsernameValid = this.usernameValidation.isAvailable && !this.usernameValidation.isChecking;
        const isEmailValid = this.emailValidation.isAvailable && !this.emailValidation.isChecking;
        const isPasswordValid = this.passwordValidation.strength === 'medium' || this.passwordValidation.strength === 'strong';

        btn.disabled = !(isUsernameValid && isEmailValid && isPasswordValid);
    },

    usernameValidation: {
        debounceTimer: null,
        currentCheckId: 0,
        isAvailable: false,
        isChecking: false,

        reservedUsernames: [
            'admin', 'administrator', 'owner', 'moderator', 'support',
            'system', 'api', 'root', 'guest', 'null', 'undefined', 'test'
        ],

        init() {
            const input = document.getElementById('reg-name');
            if (!input) return;

            input.addEventListener('input', (e) => {
                this.handleInput(e.target.value);
            });
        },

        handleInput(value) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);

            const val = value.trim();

            if (!val) {
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('empty', 'Lowercase letters, numbers, and underscores (3-20 characters).');
                app.updateRegisterSubmitState();
                return;
            }

            // 1. Local format validation
            const localCheck = app.validateUsername(val);
            if (!localCheck.valid) {
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('invalid', localCheck.message);
                app.updateRegisterSubmitState();
                return;
            }

            // 2. Reserved username check
            if (this.reservedUsernames.includes(val.toLowerCase())) {
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('invalid', 'This username is reserved and cannot be used.');
                app.updateRegisterSubmitState();
                return;
            }

            // 3. Show checking UI & debounce 500ms
            this.isChecking = true;
            this.isAvailable = false;
            this.updateUI('checking', 'Checking username availability...');
            app.updateRegisterSubmitState();

            const checkId = ++this.currentCheckId;

            this.debounceTimer = setTimeout(async () => {
                await this.checkDatabase(val, checkId);
            }, 500);
        },

        async checkDatabase(username, checkId) {
            const cleanUsername = username.trim().toLowerCase();

            try {
                const { data, error } = await supabaseClient
                    .from('profiles')
                    .select('username')
                    .eq('username', cleanUsername);

                console.log('[USERNAME CHECK]', cleanUsername);
                console.log('[USERNAME RESULT]', data);
                console.log('[USERNAME ERROR]', error);

                if (checkId !== this.currentCheckId) return;

                this.isChecking = false;

                if (error) {
                    console.error('Error checking username availability:', error);
                    this.isAvailable = false;
                    this.updateUI('invalid', 'Failed to verify username. Please try again.');
                    app.updateRegisterSubmitState();
                    return;
                }

                // Jika data ditemukan (array berisi setidaknya 1 row) -> Taken
                if (data && data.length > 0) {
                    this.isAvailable = false;
                    this.updateUI('taken', 'This username is already taken. Please choose another one.');
                    app.updateRegisterSubmitState();
                } else {
                    this.isAvailable = true;
                    this.updateUI('available', 'Username is available.');
                    app.updateRegisterSubmitState();
                }
            } catch (err) {
                if (checkId !== this.currentCheckId) return;
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('invalid', 'An error occurred while checking username.');
                app.updateRegisterSubmitState();
            }
        },

        updateUI(state, message) {
            const iconContainer = document.getElementById('username-status-icon');
            const textContainer = document.getElementById('username-status-text');
            const inputEl = document.getElementById('reg-name');

            if (!iconContainer || !textContainer || !inputEl) return;

            inputEl.classList.remove('border-emerald-500/50', 'border-red-500/50', 'border-slate-700');

            if (state === 'empty') {
                iconContainer.classList.add('hidden');
                iconContainer.innerHTML = '';
                textContainer.className = 'text-xs text-slate-500 mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-slate-700');
            } else if (state === 'checking') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-slate-400"></i>';
                textContainer.className = 'text-xs text-slate-400 mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-slate-700');
            } else if (state === 'available') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i>';
                textContainer.className = 'text-xs text-emerald-400 font-medium mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-emerald-500/50');
            } else if (state === 'taken' || state === 'invalid') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-circle-xmark text-red-400"></i>';
                textContainer.className = 'text-xs text-red-400 font-medium mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-red-500/50');
            }
        },

        reset() {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.currentCheckId++;
            this.isAvailable = false;
            this.isChecking = false;
            this.updateUI('empty', 'Huruf kecil, angka, dan underscore (3-20 karakter).');
            app.updateRegisterSubmitState();
        }
    },

    editUsernameValidation: {
        debounceTimer: null,
        currentCheckId: 0,
        isValid: true,
        isChecking: false,

        init() {
            const input = document.getElementById('edit-username');
            if (!input) return;

            input.addEventListener('input', (e) => {
                this.handleInput(e.target.value);
            });
        },

        handleInput(value) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);

            const val = value.trim();
            const currentUser = app.state.user;

            if (!val) {
                this.isChecking = false;
                this.isValid = false;
                this.updateUI('invalid', 'Username tidak boleh kosong.');
                this.toggleSaveButton(false);
                return;
            }

            // Local format & reserved username validation
            const formatCheck = app.validateUsername(val);
            if (!formatCheck.valid) {
                this.isChecking = false;
                this.isValid = false;
                this.updateUI('invalid', formatCheck.message);
                this.toggleSaveButton(false);
                return;
            }

            // Self-username exemption: if matches logged in user's username
            if (currentUser && currentUser.username && val.toLowerCase() === currentUser.username.toLowerCase()) {
                this.isChecking = false;
                this.isValid = true;
                this.updateUI('available', 'Username Anda saat ini.');
                this.toggleSaveButton(true);
                return;
            }

            // Show checking UI & debounce 500ms
            this.isChecking = true;
            this.isValid = false;
            this.updateUI('checking', 'Memeriksa ketersediaan username...');
            this.toggleSaveButton(false);

            const checkId = ++this.currentCheckId;

            this.debounceTimer = setTimeout(async () => {
                await this.checkDatabase(val, checkId);
            }, 500);
        },

        async checkDatabase(username, checkId) {
            const cleanUsername = username.trim().toLowerCase();
            const currentUserId = app.state.user?.id;

            try {
                let query = supabaseClient
                    .from('profiles')
                    .select('id, username')
                    .eq('username', cleanUsername);

                if (currentUserId) {
                    query = query.neq('id', currentUserId);
                }

                const { data, error } = await query;

                if (checkId !== this.currentCheckId) return;

                this.isChecking = false;

                if (error) {
                    console.error('Error checking edit username availability:', error);
                    this.isValid = false;
                    this.updateUI('invalid', 'Gagal memverifikasi username. Silakan coba lagi.');
                    this.toggleSaveButton(false);
                    return;
                }

                if (data && data.length > 0) {
                    this.isValid = false;
                    this.updateUI('taken', 'Username ini sudah digunakan. Silakan pilih username lain.');
                    this.toggleSaveButton(false);
                } else {
                    this.isValid = true;
                    this.updateUI('available', 'Username tersedia.');
                    this.toggleSaveButton(true);
                }
            } catch (err) {
                if (checkId !== this.currentCheckId) return;
                this.isChecking = false;
                this.isValid = false;
                this.updateUI('invalid', 'Terjadi kesalahan saat memeriksa username.');
                this.toggleSaveButton(false);
            }
        },

        updateUI(state, message) {
            const iconContainer = document.getElementById('edit-username-status-icon');
            const textContainer = document.getElementById('edit-username-status-text');
            const inputEl = document.getElementById('edit-username');

            if (!iconContainer || !textContainer || !inputEl) return;

            inputEl.classList.remove('border-emerald-500/50', 'border-red-500/50', 'border-slate-700');

            if (state === 'empty') {
                iconContainer.classList.add('hidden');
                iconContainer.innerHTML = '';
                textContainer.className = 'text-xs text-slate-500 mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-slate-700');
            } else if (state === 'checking') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-slate-400"></i>';
                textContainer.className = 'text-xs text-slate-400 mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-slate-700');
            } else if (state === 'available') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i>';
                textContainer.className = 'text-xs text-emerald-400 font-medium mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-emerald-500/50');
            } else if (state === 'taken' || state === 'invalid') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-circle-xmark text-red-400"></i>';
                textContainer.className = 'text-xs text-red-400 font-medium mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-red-500/50');
            }
        },

        toggleSaveButton(enabled) {
            const btn = document.getElementById('btn-save-profile');
            if (btn) {
                btn.disabled = !enabled;
            }
        },

        reset() {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.currentCheckId++;
            this.isValid = true;
            this.isChecking = false;
            this.updateUI('empty', '');
            this.toggleSaveButton(true);
        }
    },

    emailValidation: {
        debounceTimer: null,
        currentCheckId: 0,
        isAvailable: false,
        isChecking: false,

        init() {
            const input = document.getElementById('reg-email');
            if (!input) return;

            input.addEventListener('input', (e) => {
                this.handleInput(e.target.value);
            });
        },

        validateFormat(email) {
            if (!email || email.trim() === '') {
                return { valid: false, message: 'Email tidak boleh kosong.' };
            }
            const clean = email.trim().toLowerCase();
            const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
            if (!emailRegex.test(clean)) {
                return { valid: false, message: 'Format email tidak valid (contoh: user@gmail.com).' };
            }
            return { valid: true, value: clean };
        },

        handleInput(value) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);

            const val = value.trim();

            if (!val) {
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('empty', 'Gunakan email aktif Anda.');
                app.updateRegisterSubmitState();
                return;
            }

            const formatCheck = this.validateFormat(val);
            if (!formatCheck.valid) {
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('invalid', formatCheck.message);
                app.updateRegisterSubmitState();
                return;
            }

            this.isChecking = true;
            this.isAvailable = false;
            this.updateUI('checking', 'Memeriksa email...');
            app.updateRegisterSubmitState();

            const checkId = ++this.currentCheckId;

            this.debounceTimer = setTimeout(async () => {
                await this.checkDatabase(formatCheck.value, checkId);
            }, 500);
        },

        async checkDatabase(email, checkId) {
            try {
                const { data, error } = await supabaseClient
                    .from('profiles')
                    .select('email')
                    .ilike('email', email);

                if (checkId !== this.currentCheckId) return;

                this.isChecking = false;

                if (error) {
                    console.error('Error checking email availability:', error);
                    this.isAvailable = false;
                    this.updateUI('invalid', 'Gagal memverifikasi email. Silakan coba lagi.');
                    app.updateRegisterSubmitState();
                    return;
                }

                if (data && data.length > 0) {
                    this.isAvailable = false;
                    this.updateUI('taken', 'Email ini sudah terdaftar. Silakan gunakan email lain atau masuk.');
                    app.updateRegisterSubmitState();
                } else {
                    this.isAvailable = true;
                    this.updateUI('available', 'Email tersedia.');
                    app.updateRegisterSubmitState();
                }
            } catch (err) {
                if (checkId !== this.currentCheckId) return;
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('invalid', 'Terjadi kesalahan saat memeriksa email.');
                app.updateRegisterSubmitState();
            }
        },

        updateUI(state, message) {
            const iconContainer = document.getElementById('email-status-icon');
            const textContainer = document.getElementById('email-status-text');
            const inputEl = document.getElementById('reg-email');

            if (!iconContainer || !textContainer || !inputEl) return;

            inputEl.classList.remove('border-emerald-500/50', 'border-red-500/50', 'border-slate-700');

            if (state === 'empty') {
                iconContainer.classList.add('hidden');
                iconContainer.innerHTML = '';
                textContainer.className = 'text-xs text-slate-500 mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-slate-700');
            } else if (state === 'checking') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-slate-400"></i>';
                textContainer.className = 'text-xs text-slate-400 mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-slate-700');
            } else if (state === 'available') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i>';
                textContainer.className = 'text-xs text-emerald-400 font-medium mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-emerald-500/50');
            } else if (state === 'taken' || state === 'invalid') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-circle-xmark text-red-400"></i>';
                textContainer.className = 'text-xs text-red-400 font-medium mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-red-500/50');
            }
        },

        reset() {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.currentCheckId++;
            this.isAvailable = false;
            this.isChecking = false;
            this.updateUI('empty', 'Gunakan email aktif Anda.');
        }
    },

    passwordValidation: {
        strength: 'weak',

        init() {
            const input = document.getElementById('reg-pwd');
            if (!input) return;

            input.addEventListener('input', (e) => {
                this.handleInput(e.target.value);
            });
        },

        handleInput(pwd) {
            const container = document.getElementById('pwd-strength-container');
            const textEl = document.getElementById('pwd-strength-text');
            const bar1 = document.getElementById('pwd-bar-1');
            const bar2 = document.getElementById('pwd-bar-2');
            const bar3 = document.getElementById('pwd-bar-3');

            if (!pwd) {
                this.strength = 'weak';
                if (container) container.classList.add('hidden');
                app.updateRegisterSubmitState();
                return;
            }

            if (container) container.classList.remove('hidden');

            let score = 0;
            if (pwd.length >= 8) score++;
            if (/[a-z]/.test(pwd)) score++;
            if (/[A-Z]/.test(pwd)) score++;
            if (/[0-9]/.test(pwd)) score++;
            if (/[^a-zA-Z0-9]/.test(pwd)) score++;

            if (pwd.length < 6 || score <= 2) {
                this.strength = 'weak';
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-red-400 mt-1';
                    textEl.innerText = 'Password terlalu lemah.';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-red-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
            } else if (score === 3 || score === 4) {
                this.strength = 'medium';
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-amber-400 mt-1';
                    textEl.innerText = 'Kekuatan password cukup.';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-amber-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-amber-500 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
            } else if (score >= 5) {
                this.strength = 'strong';
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-emerald-400 mt-1';
                    textEl.innerText = 'Password kuat.';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
            }

            app.updateRegisterSubmitState();
        },

        reset() {
            this.strength = 'weak';
            const container = document.getElementById('pwd-strength-container');
            if (container) container.classList.add('hidden');
        }
    },

    onboardingUsernameValidation: {
        debounceTimer: null,
        currentCheckId: 0,
        isAvailable: false,
        isChecking: false,

        reservedUsernames: [
            'admin', 'administrator', 'owner', 'moderator', 'support',
            'system', 'api', 'root', 'guest', 'null', 'undefined', 'test'
        ],

        init() {
            const input = document.getElementById('onboarding-username');
            if (!input) return;

            input.addEventListener('input', (e) => {
                this.handleInput(e.target.value);
            });
        },

        handleInput(value) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            const val = value.trim();

            if (!val) {
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('empty', 'Huruf kecil, angka, dan underscore (3-20 karakter).');
                this.toggleSubmitButton(false);
                return;
            }

            const localCheck = app.validateUsername(val);
            if (!localCheck.valid) {
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('invalid', localCheck.message);
                this.toggleSubmitButton(false);
                return;
            }

            if (this.reservedUsernames.includes(val.toLowerCase())) {
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('invalid', 'Username ini dicadangkan (reserved) dan tidak dapat digunakan.');
                this.toggleSubmitButton(false);
                return;
            }

            this.isChecking = true;
            this.isAvailable = false;
            this.updateUI('checking', 'Memeriksa ketersediaan username...');
            this.toggleSubmitButton(false);

            const checkId = ++this.currentCheckId;

            this.debounceTimer = setTimeout(async () => {
                await this.checkDatabase(val, checkId);
            }, 500);
        },

        async checkDatabase(username, checkId) {
            const cleanUsername = username.trim().toLowerCase();

            try {
                const { data, error } = await supabaseClient
                    .from('profiles')
                    .select('username')
                    .eq('username', cleanUsername);

                if (checkId !== this.currentCheckId) return;

                this.isChecking = false;

                if (error) {
                    console.error('Error checking username availability:', error);
                    this.isAvailable = false;
                    this.updateUI('invalid', 'Gagal memverifikasi username. Silakan coba lagi.');
                    this.toggleSubmitButton(false);
                    return;
                }

                if (data && data.length > 0) {
                    this.isAvailable = false;
                    this.updateUI('taken', 'Username ini sudah digunakan. Silakan pilih username lain.');
                    this.toggleSubmitButton(false);
                } else {
                    this.isAvailable = true;
                    this.updateUI('available', 'Username tersedia.');
                    this.toggleSubmitButton(true);
                }
            } catch (err) {
                if (checkId !== this.currentCheckId) return;
                this.isChecking = false;
                this.isAvailable = false;
                this.updateUI('invalid', 'Terjadi kesalahan saat memeriksa username.');
                this.toggleSubmitButton(false);
            }
        },

        updateUI(state, message) {
            const iconContainer = document.getElementById('onboarding-username-status-icon');
            const textContainer = document.getElementById('onboarding-username-status-text');
            const inputEl = document.getElementById('onboarding-username');

            if (!iconContainer || !textContainer || !inputEl) return;

            inputEl.classList.remove('border-emerald-500/50', 'border-red-500/50', 'border-slate-700');

            if (state === 'empty') {
                iconContainer.classList.add('hidden');
                iconContainer.innerHTML = '';
                textContainer.className = 'text-xs text-slate-500 mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-slate-700');
            } else if (state === 'checking') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-slate-400"></i>';
                textContainer.className = 'text-xs text-slate-400 mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-slate-700');
            } else if (state === 'available') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i>';
                textContainer.className = 'text-xs text-emerald-400 font-medium mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-emerald-500/50');
            } else if (state === 'taken' || state === 'invalid') {
                iconContainer.classList.remove('hidden');
                iconContainer.innerHTML = '<i class="fa-solid fa-circle-xmark text-red-400"></i>';
                textContainer.className = 'text-xs text-red-400 font-medium mt-1';
                textContainer.innerText = message;
                inputEl.classList.add('border-red-500/50');
            }
        },

        toggleSubmitButton(enabled) {
            const btn = document.getElementById('btn-onboarding-submit');
            if (btn) {
                btn.disabled = !enabled;
            }
        },

        reset() {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.currentCheckId++;
            this.isAvailable = false;
            this.isChecking = false;
            const inputEl = document.getElementById('onboarding-username');
            if (inputEl) inputEl.value = '';
            this.updateUI('empty', 'Huruf kecil, angka, dan underscore (3-20 karakter).');
            this.toggleSubmitButton(false);
        }
    },

    // ======================== INIT ========================
    async init() {
        await checkSession();

        // Parse route from hash or URL parameters on initial page load
        const routeFromHash = this.getRouteFromHash();
        if (routeFromHash) {
            this.navigate(routeFromHash, true);
        } else if (this.state.user && !this.state.user.isGuest) {
            this.navigate('dashboard', true);
        } else {
            this.navigate('home', true);
        }

        // Listen for hash changes (browser Back and Forward buttons)
        window.addEventListener('hashchange', () => {
            if (this.state.isInternalHashChange) {
                this.state.isInternalHashChange = false;
                return;
            }
            const newRoute = this.getRouteFromHash();
            if (newRoute && newRoute !== this.state.currentView) {
                this.navigate(newRoute, false);
            }
        });

        this.syncAuthStateDisplay();
        this.bindGlobalProtection();
        this.usernameValidation.init();
        this.editUsernameValidation.init();
        this.emailValidation.init();
        this.passwordValidation.init();
        this.changePasswordValidation.init();
        this.onboardingUsernameValidation.init();
        this.leaderboard.generateDummyData();
        this.articles.init();
        this.inactivity.init();
        this.inactivity.startMonitoring();

        // Restore announcement state
        if (this.state.announcementDismissed) {
            const banner = document.getElementById('announcement-banner');
            if (banner) banner.classList.add('hidden');
        }

        // Real-time Supabase Auth Session listener
        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            // Skip auth state changes during manual email registration
            if (app.state.isRegistering) {
                console.log('[AUTH] onAuthStateChange skipped — registration in progress');
                return;
            }

            if (event === 'PASSWORD_RECOVERY') {
                app.state.isRecoverySession = true;
                app.navigate('reset-password');
                return;
            }

            if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                if (session?.user) {
                    const isExplicitGoogle = sessionStorage.getItem('kt_google_login_pending') === 'true';
                    await app.processSessionUser(session.user, isExplicitGoogle);
                }
            } else if (event === 'SIGNED_OUT') {
                app.state.user = null;
                app.state.pendingGoogleAuth = null;
                app.state.history = [];
                localStorage.removeItem('kt_user');
                localStorage.removeItem('kt_history');
                app.syncAuthStateDisplay();
                app.navigate('home', true);
            }
        });

        // Re-evaluate mobile nav on window resize / screen rotation
        window.addEventListener('resize', () => {
            app.updateActiveNav(app.state.currentView);
            const nav = document.getElementById('mobile-nav');
            if (nav) {
                app.applyMobileNavVisibility(nav);
            }
        });

        // Auto-refresh leaderboard single source of truth on page focus
        window.addEventListener('focus', () => {
            if (app.state.user && !app.state.user.isGuest) {
                app.getLeaderboardData('alltime', true);
                app.getLeaderboardData('weekly', true);
                if (app.state.currentView === 'leaderboard' && app.leaderboard) {
                    app.leaderboard.render();
                }
            }
        });
    },

    getRouteFromHash() {
        const path = window.location.pathname;
        const hash = window.location.hash;
        const search = window.location.search;

        // Password Recovery / Reset check (query params, hash or path)
        if (path.includes('reset-password') || hash.includes('reset-password') || search.includes('type=recovery') || hash.includes('type=recovery')) {
            return 'reset-password';
        }
        if (path.includes('forgot-password') || hash.includes('forgot-password') || hash === '#forgot' || hash === '#forgot-password') {
            return 'forgot-password';
        }

        // Verify Email check (query params, hash or path)
        if (path.includes('verify-email') || hash.includes('verify-email') || search.includes('token_hash') || search.includes('type=signup') || search.includes('type=email') || (search.includes('code=') && !hash.includes('access_token='))) {
            return 'verify-email';
        }

        // Admin route check
        if (hash === '#/admin' || hash === '#admin' || path.endsWith('/admin')) {
            return 'admin';
        }

        // Parse standard hash
        if (hash) {
            let route = hash;
            if (route.startsWith('#')) route = route.slice(1);
            if (route.startsWith('/')) route = route.slice(1);

            // Strip any query params from hash
            if (route.includes('?')) {
                route = route.split('?')[0];
            }

            route = route.trim();
            if (route !== '') {
                return route;
            }
        }

        return null;
    },

    // ======================== TOAST SYSTEM ========================
    toast: {
        show(message, type = 'info', duration = 3500) {
            const container = document.getElementById('toast-container');
            if (!container) return;

            const toast = document.createElement('div');
            let borderColor = 'border-l-cyan-400';
            let icon = 'fa-circle-info';
            let iconColor = 'text-cyan-400';

            if (type === 'success') { borderColor = 'border-l-emerald-400'; icon = 'fa-circle-check'; iconColor = 'text-emerald-400'; }
            else if (type === 'warning') { borderColor = 'border-l-amber-400'; icon = 'fa-triangle-exclamation'; iconColor = 'text-amber-400'; }
            else if (type === 'error') { borderColor = 'border-l-red-400'; icon = 'fa-circle-xmark'; iconColor = 'text-red-400'; }

            toast.className = `toast bg-slate-800 border border-slate-700 border-l-4 ${borderColor} rounded-lg px-4 py-3 flex items-center space-x-3 shadow-xl min-w-[280px] max-w-[380px]`;
            toast.innerHTML = `
                <i class="fa-solid ${icon} ${iconColor}"></i>
                <span class="text-sm text-slate-200 flex-1">${message}</span>
                <button onclick="this.parentElement.remove()" class="text-slate-500 hover:text-slate-300"><i class="fa-solid fa-xmark text-xs"></i></button>
            `;
            container.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('toast-exit');
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }
    },

    // ======================== NAVIGATION ========================
    navigate(viewId, updateHash = true) {
        if (viewId === 'verify-email' || viewId === 'verify') viewId = 'verify-email';
        if (viewId === 'forgot' || viewId === 'forgot-password') viewId = 'forgot-password';
        if (viewId === 'reset' || viewId === 'reset-password') viewId = 'reset-password';

        // Stop email verification polling if leaving verify-email view
        if (this.state.currentView === 'verify-email' && viewId !== 'verify-email') {
            this.stopEmailVerificationPolling();
        }

        // Guard: Authenticated user accessing forgot-password redirects to dashboard
        if (this.state.user && !this.state.user.isGuest && viewId === 'forgot-password' && !this.state.isRecoverySession) {
            viewId = 'dashboard';
        }

        // Guard: Onboarding protection for Google Auth
        if (this.state.pendingGoogleAuth && !this.state.user && viewId !== 'onboarding') {
            this.toast.show('Silakan selesaikan pendaftaran username terlebih dahulu.', 'warning');
            viewId = 'onboarding';
        }

        // Guard: test is running
        if (this.state.isTestRunning && viewId !== 'test-screen') {
            if (!confirm('Tes sedang berlangsung. Apakah Anda yakin ingin keluar?')) return;
            this.actions.terminateTestEngine();
        }

        // Authenticated user Home / Login / Register -> Dashboard redirection
        if (this.state.user && !this.state.user.isGuest && (viewId === 'home' || viewId === 'login' || viewId === 'register')) {
            viewId = 'dashboard';
        }
        // Guest user Dashboard / Protected Views -> Login redirection
        if ((!this.state.user || this.state.user.isGuest) && (viewId === 'dashboard' || viewId === 'profile' || viewId === 'edit-profile' || viewId === 'achievements' || viewId === 'history')) {
            viewId = 'login';
        }

        // Account view routing
        if (viewId === 'account' && this.state.user && !this.state.user.isGuest) {
            viewId = 'profile';
        } else if (viewId === 'account' && (!this.state.user || this.state.user.isGuest)) {
            viewId = 'login';
        }

        // Synchronize browser URL hash for all application pages EXCEPT verify-email callback
        if (updateHash !== false && viewId !== 'verify-email') {
            const targetHash = '#' + viewId;
            if (window.location.hash !== targetHash && !window.location.hash.startsWith(targetHash + '?')) {
                this.state.isInternalHashChange = true;
                window.location.hash = targetHash;
            }
        }

        const loader = document.getElementById('global-loader');
        if (loader) loader.classList.remove('hidden');

        setTimeout(async () => {
            document.querySelectorAll('.page-view').forEach(v => {
                v.classList.remove('active');
                v.classList.add('hidden');
            });

            // Toggle navigation bars for fullscreen views (admin & test-screen)
            if (viewId === 'admin' || viewId === 'test-screen') {
                document.body.classList.add('hide-navs');
            } else {
                document.body.classList.remove('hide-navs');
            }

            // Immediately update mobile nav visibility after fullscreen toggle
            const mobileNavEl = document.getElementById('mobile-nav');
            if (mobileNavEl) {
                this.applyMobileNavVisibility(mobileNavEl);
            }

            const target = document.getElementById(`view-${viewId}`);
            if (target) {
                target.classList.remove('hidden');
                target.classList.add('active');
            }

            // Sync auth state display & update active nav state
            this.syncAuthStateDisplay();
            this.updateActiveNav(viewId);

            // Store current view
            this.state.currentView = viewId;

            // Render data for specific views
            if (viewId === 'dashboard') await this.renderDashboard();
            if (viewId === 'leaderboard') this.leaderboard.render();
            if (viewId === 'profile') await this.renderProfile();
            if (viewId === 'edit-profile') this.renderEditProfile();
            if (viewId === 'achievements') this.renderAchievements();
            if (viewId === 'history') await this.renderHistoryStatistics();
            if (viewId === 'articles') this.articles.renderList();
            if (viewId === 'verify-email') this.initVerifyEmailView();
            if (viewId === 'forgot-password') this.initForgotPasswordView();
            if (viewId === 'reset-password') this.initResetPasswordView();

            if (viewId === 'register') this.resetAuthForms('register');
            if (viewId === 'login') {
                const banner = document.getElementById('unverified-email-banner');
                const msgEl = document.getElementById('unverified-banner-msg');

                // Check for post-registration email autofill
                const postRegEmail = sessionStorage.getItem('kt_post_register_email');
                const isJustVerified = sessionStorage.getItem('kt_verification_just_completed') === 'true';

                if (postRegEmail) {
                    sessionStorage.removeItem('kt_post_register_email');
                    sessionStorage.removeItem('kt_verification_just_completed');
                    const loginEmailInput = document.getElementById('login-email');
                    const loginPwdInput = document.getElementById('login-pwd');
                    if (loginEmailInput) loginEmailInput.value = postRegEmail;
                    if (loginPwdInput) {
                        loginPwdInput.value = '';
                        setTimeout(() => loginPwdInput.focus(), 200);
                    }

                    if (isJustVerified) {
                        if (banner) banner.classList.add('hidden');
                        app.toast.show('Your email has been verified successfully. Please sign in to continue.', 'success');
                    } else {
                        if (banner) banner.classList.remove('hidden');
                        if (msgEl) msgEl.innerText = 'Your account has been created successfully. Please verify your email before signing in.';
                    }
                    console.log('[NAVIGATION] Login (post-verification, email autofilled)');
                } else {
                    this.resetAuthForms('login');
                    if (banner && !app.state.unverifiedEmail) {
                        banner.classList.add('hidden');
                    }
                }
            }

            if (loader) loader.classList.add('hidden');

            // Scroll to top
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 150);
    },

    async renderDashboard() {
        if (!this.state.user) return;

        // Render Hero System
        await this.renderDashboardHero();

        const el = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };
        el('dash-best-score', (this.state.user.best_standard_score || 0) + ' pts');
        el('dash-best-acc', (this.state.user.best_standard_accuracy || 0) + '%');
        el('dash-best-cons', this.state.user.best_standard_consistency || 100);

        let recent = null;
        if (this.state.history && this.state.history.length > 0) {
            recent = this.state.history[0];
        } else if (!this.state.user.isGuest) {
            try {
                const { data } = await supabaseClient
                    .from('test_results')
                    .select('*')
                    .eq('user_id', this.state.user.id)
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (data) recent = data;
            } catch (e) {
                console.error('Error fetching recent test for dashboard:', e);
            }
        }

        if (recent) {
            el('dash-recent-mode', recent.mode || 'Standard Test');
            el('dash-recent-score', (recent.score || 0) + ' pts');
            const corr = recent.correct_answers !== undefined ? recent.correct_answers : (recent.correctAnswers !== undefined ? recent.correctAnswers : '—');
            const wrng = recent.wrong_answers !== undefined ? recent.wrong_answers : (recent.wrongAnswers !== undefined ? recent.wrongAnswers : '—');
            el('dash-recent-correct', corr !== '—' ? `${corr} soal` : '—');
            el('dash-recent-wrong', wrng !== '—' ? `${wrng} soal` : '—');

            const d = recent.created_at ? new Date(recent.created_at) : (recent.date ? new Date() : null);
            el('dash-recent-date', d ? d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Recent');
        } else {
            el('dash-recent-mode', 'None Yet');
            el('dash-recent-score', '0 pts');
            el('dash-recent-correct', '—');
            el('dash-recent-wrong', '—');
            el('dash-recent-date', 'No Tests Yet');
        }

        // Weekly Rank calculation
        if (this.state.user && !this.state.user.isGuest) {
            try {
                const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
                const { data: rawWeekly } = await supabaseClient
                    .from('test_results')
                    .select('user_id, score, accuracy, consistency, created_at')
                    .in('mode', ['Standard Test', 'Standard', 'standard'])
                    .eq('is_valid', true)
                    .eq('is_flagged', false)
                    .gte('created_at', sevenDaysAgo)
                    .order('score', { ascending: false });

                if (rawWeekly && rawWeekly.length > 0) {
                    const userBestMap = new Map();
                    for (const row of rawWeekly) {
                        if (!row.user_id) continue;
                        if (!userBestMap.has(row.user_id)) {
                            userBestMap.set(row.user_id, row);
                        } else {
                            const existing = userBestMap.get(row.user_id);
                            if (row.score > existing.score ||
                               (row.score === existing.score && row.accuracy > existing.accuracy) ||
                               (row.score === existing.score && row.accuracy === existing.accuracy && row.consistency > existing.consistency)) {
                                userBestMap.set(row.user_id, row);
                            }
                        }
                    }

                    const sortedWeekly = Array.from(userBestMap.values()).sort((a, b) => {
                        if (b.score !== a.score) return b.score - a.score;
                        if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
                        if (b.consistency !== a.consistency) return b.consistency - a.consistency;
                        return new Date(a.created_at) - new Date(b.created_at);
                    });

                    const foundIndex = sortedWeekly.findIndex(p => p.user_id === this.state.user.id);
                    if (foundIndex !== -1) {
                        el('dash-weekly-rank', '#' + (foundIndex + 1));
                    } else {
                        el('dash-weekly-rank', '—');
                    }
                } else {
                    el('dash-weekly-rank', '—');
                }
            } catch (e) {
                console.error('Error fetching weekly rank for dashboard:', e);
                el('dash-weekly-rank', '—');
            }
        } else {
            el('dash-weekly-rank', '—');
        }
    },

    // ======================== DAILY MOTIVATION & DASHBOARD HERO ========================
    motivationalQuotes: [
        "Focus is the ultimate key to conquering every calculation challenge.",
        "Daily consistency yields extraordinary results over time.",
        "High accuracy stems from a calm mind and regular practice.",
        "Discipline is the bridge between goals and real achievement.",
        "Speed comes naturally as accuracy and confidence grow.",
        "It's not about how fast you start, but how consistently you endure.",
        "Today's practice is the foundation for tomorrow's performance.",
        "Every correctly calculated number brings you closer to the top.",
        "Focus on the process, and peak performance will naturally follow.",
        "Mental endurance in speed tests relies on a steady, rhythmic pace.",
        "Believing in your ability is half the battle won.",
        "Small daily efforts far outweigh occasional intense bursts.",
        "Accuracy is the highest form of respect for the process.",
        "Elevate your consistency curve one step at a time.",
        "Precision separates the ordinary from the extraordinary.",
        "The greatest hurdle is self-doubt. Break through it!",
        "Calculation speed is a byproduct of undiverted concentration.",
        "Make every practice second a demonstration of your true potential.",
        "Five minutes of daily discipline is worth more than empty promises.",
        "True progress is measured by the growth of your weekly consistency.",
        "Clarity of mind produces precise mathematical accuracy.",
        "Never fear making mistakes while practicing; fear never starting.",
        "Top rankings are earned by those who refuse to give up.",
        "Your focus dictates your rhythm, and your rhythm determines your result.",
        "Perfection is achieved not all at once, but through relentless repetition.",
        "Set your daily target and execute with maximum precision.",
        "Speed without accuracy is futile. Prioritize precision.",
        "Every test minute is a trial of focus stamina and mental grit.",
        "Consistency is the habit of champions in every field of life.",
        "Maintain your calculation cadence even when time pressure mounts.",
        "Peak energy flows when you enjoy every phase of your training.",
        "Never compare your beginning steps to someone else's peak.",
        "Discipline keeps you moving forward when motivation fades.",
        "Simulation success is the fruit of dedication during preparation.",
        "Trust that your calculation reflexes sharpen with every single session.",
        "Master your mind under high pressure, and you master the test.",
        "The secret to high scores: don't stop when tired, stop when done.",
        "Precision is the best investment in your cognitive stamina.",
        "Increase your speed gradually without compromising your accuracy.",
        "Every mistake is a valuable lesson for your next attempt.",
        "Commitment to training quality yields deeply satisfying outcomes.",
        "Use speed calculation tests as a platform to hone your best focus.",
        "True victory is outperforming who you were yesterday.",
        "Stability from start to finish marks true mental endurance.",
        "Focus on the present moment, ignore distractions, and finish strong.",
        "Perseverance is the secret fuel that turns potential into excellence.",
        "Consistent practice is the surest path to the top ranking.",
        "A clear mind and swift hands form an unbeatable combination.",
        "Every second spent practicing is a step toward your aspirations.",
        "Keep pushing your boundaries; you are stronger than you think."
    ],

    getDailyMotivationQuote() {
        const now = new Date();
        const dayKey = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
        const index = Math.abs(dayKey) % this.motivationalQuotes.length;
        return this.motivationalQuotes[index];
    },

    // ======================== SINGLE SOURCE OF TRUTH LEADERBOARD SERVICE ========================
    getCurrentWeekRangeWIB() {
        const now = new Date();
        const wibOffsetMs = 7 * 60 * 60 * 1000;
        const wibNow = new Date(now.getTime() + wibOffsetMs);

        // Day of week in WIB: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
        const day = wibNow.getUTCDay();
        const diffToMonday = day === 0 ? 6 : (day - 1);

        const mondayWib = new Date(wibNow);
        mondayWib.setUTCDate(wibNow.getUTCDate() - diffToMonday);
        mondayWib.setUTCHours(0, 0, 0, 0);

        const sundayWib = new Date(mondayWib);
        sundayWib.setUTCDate(mondayWib.getUTCDate() + 6);
        sundayWib.setUTCHours(23, 59, 59, 999);

        // Next Monday 00:00:00 WIB for reset countdown
        const nextMondayWib = new Date(mondayWib);
        nextMondayWib.setUTCDate(mondayWib.getUTCDate() + 7);
        nextMondayWib.setUTCHours(0, 0, 0, 0);

        // ISO strings in UTC for Supabase query
        const startUtcIso = new Date(mondayWib.getTime() - wibOffsetMs).toISOString();
        const endUtcIso = new Date(sundayWib.getTime() - wibOffsetMs).toISOString();
        const nextMondayUtcMs = nextMondayWib.getTime() - wibOffsetMs;

        return {
            mondayWib,
            sundayWib,
            nextMondayWib,
            startUtcIso,
            endUtcIso,
            nextMondayUtcMs,
            wibNow
        };
    },

    async getLeaderboardData(timeframe = 'alltime', forceRefresh = false) {
        const cacheKey = `lb_cache_${timeframe}`;
        if (!forceRefresh && this.state[cacheKey] && (Date.now() - this.state[cacheKey].timestamp < 15000)) {
            return this.state[cacheKey].data;
        }

        console.log('[LEADERBOARD SINGLE SOURCE QUERY]', timeframe);

        try {
            let query = supabaseClient
                .from('test_results')
                .select(`
                    id,
                    user_id,
                    score,
                    accuracy,
                    consistency,
                    created_at,
                    mode,
                    is_valid,
                    is_flagged,
                    profiles (
                        id,
                        username,
                        display_name,
                        avatar_url
                    )
                `)
                .in('mode', ['Standard Test', 'Standard', 'standard', 'standard_test']);

            if (timeframe === 'weekly') {
                const weekRange = this.getCurrentWeekRangeWIB();
                query = query.gte('created_at', weekRange.startUtcIso).lte('created_at', weekRange.endUtcIso);
            }

            const { data, error } = await query
                .order('score', { ascending: false })
                .order('accuracy', { ascending: false })
                .order('consistency', { ascending: false })
                .order('created_at', { ascending: true });

            if (error) {
                console.error('[LEADERBOARD QUERY ERROR]', error);
                throw error;
            }

            // Group by user_id: single best test_results record per user
            const userBestMap = new Map();
            for (const row of (data || [])) {
                if (!row.user_id || !row.profiles) continue;
                if (row.is_valid === false || row.is_flagged === true) continue;

                const uid = row.user_id;
                const candidate = {
                    id: uid,
                    user_id: uid,
                    username: row.profiles.username,
                    display_name: row.profiles.display_name,
                    avatar_url: row.profiles.avatar_url,
                    score: Math.round(row.score || 0),
                    accuracy: row.accuracy || 0,
                    consistency: row.consistency !== undefined ? row.consistency : 100,
                    created_at: row.created_at
                };

                if (!userBestMap.has(uid)) {
                    userBestMap.set(uid, candidate);
                } else {
                    const existing = userBestMap.get(uid);
                    let isBetter = false;
                    if (candidate.score > existing.score) {
                        isBetter = true;
                    } else if (candidate.score === existing.score) {
                        if (candidate.accuracy > existing.accuracy) {
                            isBetter = true;
                        } else if (candidate.accuracy === existing.accuracy) {
                            if (candidate.consistency > existing.consistency) {
                                isBetter = true;
                            } else if (candidate.consistency === existing.consistency) {
                                if (new Date(candidate.created_at).getTime() < new Date(existing.created_at).getTime()) {
                                    isBetter = true;
                                }
                            }
                        }
                    }

                    if (isBetter) {
                        userBestMap.set(uid, candidate);
                    }
                }
            }

            // Sort all deduplicated entries (tie-breakers: score > accuracy > consistency > created_at ASC)
            const sortedList = Array.from(userBestMap.values()).sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
                if (b.consistency !== a.consistency) return b.consistency - a.consistency;
                return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
            });

            // Assign ranks (1..N)
            const rankedData = sortedList.map((item, i) => ({
                ...item,
                rank: i + 1,
                best_standard_score: item.score,
                best_standard_accuracy: item.accuracy,
                best_standard_consistency: item.consistency,
                best_standard_test_date: item.created_at
            }));

            // Sync user rank & statistics in state if user is logged in
            if (this.state.user && !this.state.user.isGuest) {
                const userMatch = rankedData.find(r => r.id === this.state.user.id);
                if (userMatch) {
                    this.state.user.rank = `#${userMatch.rank}`;
                    this.state.user.best_standard_score = userMatch.score;
                    this.state.user.best_standard_accuracy = userMatch.accuracy;
                    this.state.user.best_standard_consistency = userMatch.consistency;
                    this.state.user.best_standard_test_date = userMatch.created_at;
                }
            }

            this.state[cacheKey] = {
                data: rankedData,
                timestamp: Date.now()
            };

            return rankedData;
        } catch (err) {
            console.error('[LEADERBOARD SERVICE FAILED]', err);
            return [];
        }
    },



    async renderDashboardHero() {
        const user = this.state.user;
        if (!user) return;

        const displayName = this.getEffectiveDisplayName(user);
        const greetingEl = document.getElementById('dash-hero-greeting');
        const statusEl = document.getElementById('dash-hero-status');
        const substatusEl = document.getElementById('dash-hero-substatus');
        const motivationEl = document.getElementById('dash-hero-motivation');

        // 1. Daily Motivation Quote (Deterministic)
        if (motivationEl) motivationEl.innerText = this.getDailyMotivationQuote();

        const displayNameEscaped = this.escapeHtml(displayName);

        if (user.isGuest) {
            if (greetingEl) greetingEl.innerHTML = `Welcome, <span class="text-cyan-400">${displayNameEscaped}</span> 👋`;
            if (statusEl) statusEl.innerText = 'Sign in or register to record scores and join the National Leaderboard.';
            if (substatusEl) substatusEl.innerText = '';
            return;
        }

        // 2. Fetch All Time Leaderboard ranking & Top 100 threshold from SINGLE SOURCE OF TRUTH (test_results)
        let currentRank = null;
        let top100Score = 0;
        let totalRankedUsers = 0;

        try {
            const allRanked = await this.getLeaderboardData('alltime');
            totalRankedUsers = allRanked.length;
            const userIndex = allRanked.findIndex(p => p.id === user.id);
            if (userIndex !== -1) {
                currentRank = allRanked[userIndex].rank;
            }
            if (totalRankedUsers >= 100) {
                top100Score = allRanked[99]?.score || 0;
            } else if (totalRankedUsers > 0) {
                top100Score = allRanked[totalRankedUsers - 1]?.score || 0;
            }
        } catch (err) {
            console.error('Error fetching All Time ranking for hero:', err);
        }

        const lastNotified = user.last_notified_rank !== undefined ? user.last_notified_rank : null;
        const userBestScore = user.best_standard_score || 0;
        const scoreDiff = Math.max(0, top100Score - userBestScore);

        // CASE 1: User has never completed a Standard Test
        if (!currentRank || userBestScore <= 0) {
            if (greetingEl) greetingEl.innerHTML = `Welcome, <span class="text-cyan-400">${displayNameEscaped}</span> 👋`;
            if (statusEl) statusEl.innerText = 'Complete your first Standard Test to join the leaderboard.';
            if (substatusEl) substatusEl.innerText = '';
            return;
        }

        // Default Greeting for returning users
        if (greetingEl) greetingEl.innerHTML = `Welcome back, <span class="text-cyan-400">${displayNameEscaped}</span> 👋`;

        let statusText = '';
        let substatusText = '';
        let newRankToSave = null;

        // CASE 6: Ranked #1
        if (currentRank === 1) {
            statusText = "🏆 You're currently leading the All Time Leaderboard!";
            substatusText = "Keep defending your position.";
            if (lastNotified !== 1) {
                newRankToSave = 1;
            }
        }
        // CASE 3: Rank Improved (current_rank < last_notified_rank)
        else if (lastNotified !== null && currentRank < lastNotified) {
            statusText = `🎉 Congratulations!\nYou've climbed to #${currentRank} on the All Time Leaderboard.`;
            if (currentRank <= 100) {
                substatusText = "Keep pushing toward the Top 10.";
            } else {
                substatusText = "You're getting closer to the Top 100.";
            }
            newRankToSave = currentRank;
        }
        // CASE 4: Rank Dropped (current_rank > last_notified_rank)
        else if (lastNotified !== null && currentRank > lastNotified) {
            statusText = `📉 Your All Time Leaderboard rank dropped to #${currentRank}.`;
            substatusText = "Complete another Standard Test to reclaim your position.";
            newRankToSave = currentRank;
        }
        // CASE 2: First Time Ranked Notification (last_notified_rank IS NULL)
        else if (lastNotified === null) {
            statusText = `You're currently ranked #${currentRank}.`;
            if (currentRank > 100) {
                substatusText = `You need at least ${scoreDiff} more score points to enter the Top 100.`;
            } else {
                substatusText = "Keep practicing to climb even higher.";
            }
            newRankToSave = currentRank;
        }
        // CASE 5: Rank Unchanged (current_rank === last_notified_rank)
        else {
            statusText = `You're currently ranked #${currentRank}.`;
            if (currentRank > 100) {
                substatusText = `You need at least ${scoreDiff} more score points to enter the Top 100.`;
            } else {
                substatusText = "Keep practicing to improve your position.";
            }
            newRankToSave = null; // Do NOT update database
        }

        if (statusEl) statusEl.innerText = statusText;
        if (substatusEl) substatusEl.innerText = substatusText;

        // Save to database only if newRankToSave is not null and different from lastNotified
        if (newRankToSave !== null && newRankToSave !== lastNotified) {
            try {
                const { error: updateErr } = await supabaseClient
                    .from('profiles')
                    .update({ last_notified_rank: newRankToSave })
                    .eq('id', user.id);

                if (!updateErr) {
                    user.last_notified_rank = newRankToSave;
                    this.state.user.last_notified_rank = newRankToSave;
                    localStorage.setItem('kt_user', JSON.stringify(this.state.user));
                }
            } catch (e) {
                console.error('Error updating last_notified_rank:', e);
            }
        }
    },

    updateActiveNav(viewId) {
        const isAuthed = this.state.user !== null && !this.state.user.isGuest;

        // ---- Desktop nav highlight ----
        document.querySelectorAll('#desktop-nav-guest .nav-btn, #desktop-nav-auth .nav-btn').forEach(btn => {
            btn.classList.remove('text-cyan-400');
            if (!btn.classList.contains('bg-cyan-500')) {
                btn.classList.add('text-slate-400');
            }
        });

        const desktopMap = {
            'home': 'dn-g-home',
            'dashboard': 'dn-a-dashboard',
            'test-menu': 'dn-g-test',
            'test-screen': 'dn-g-test',
            'result': 'dn-g-test',
            'articles': 'dn-g-learn',
            'article-detail': 'dn-g-learn',
            'leaderboard': 'dn-a-leaderboard',
            'account': 'dn-a-profile',
            'profile': 'dn-a-profile',
            'edit-profile': 'dn-a-profile',
            'achievements': 'dn-a-profile',
            'history': 'dn-a-profile',
            'login': 'dn-g-login',
            'register': 'dn-g-login',
        };

        const desktopBtnId = desktopMap[viewId];
        if (desktopBtnId) {
            const btn = document.getElementById(desktopBtnId);
            if (btn) {
                btn.classList.remove('text-slate-400');
                btn.classList.add('text-cyan-400');
            }
        }

        // ---- Mobile nav highlight (Single Unified Mapping) ----
        document.querySelectorAll('#mobile-nav button').forEach(btn => {
            btn.classList.remove('text-cyan-400');
            btn.classList.add('text-slate-500');
        });

        const mobileMap = {
            'home': 'mn-home',
            'dashboard': 'mn-home',
            'test-menu': 'mn-test',
            'test-screen': 'mn-test',
            'result': 'mn-test',
            'leaderboard': 'mn-leaderboard',
            'account': 'mn-profile',
            'profile': 'mn-profile',
            'edit-profile': 'mn-profile',
            'achievements': 'mn-profile',
            'history': 'mn-profile',
            'login': 'mn-profile',
            'register': 'mn-profile',
            'onboarding': 'mn-profile',
            'forgot': 'mn-profile',
            'verify': 'mn-profile'
        };

        const mobileBtnId = mobileMap[viewId];
        if (mobileBtnId) {
            const btn = document.getElementById(mobileBtnId);
            if (btn) {
                btn.classList.remove('text-slate-500');
                btn.classList.add('text-cyan-400');
            }
        }

        // ---- Debug Log [MOBILE NAV] ----
        console.log('[MOBILE NAV]', {
            currentView: viewId,
            currentActiveButton: mobileBtnId || 'none',
            navigationInitialized: true
        });
    },

    resetAuthForms(formType = 'all') {
        const fields = {
            login: ['login-email', 'login-pwd'],
            register: ['reg-name', 'reg-email', 'reg-pwd'],
            forgot: ['forgot-email']
        };

        let targetIds = [];
        if (formType === 'all') {
            targetIds = [...fields.login, ...fields.register, ...fields.forgot];
        } else if (fields[formType]) {
            targetIds = fields[formType];
        }

        targetIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        if (formType === 'all' || formType === 'register') {
            if (this.usernameValidation) this.usernameValidation.reset();
            if (this.emailValidation) this.emailValidation.reset();
            if (this.passwordValidation) this.passwordValidation.reset();
            this.updateRegisterSubmitState();
        }
        if (formType === 'all' || formType === 'edit') {
            if (this.editUsernameValidation) this.editUsernameValidation.reset();
        }
    },

    // ======================== MOBILE NAV VISIBILITY ========================
    // Uses window.innerWidth + inline style to bypass CSS media query / Tailwind CDN conflicts.
    // Mobile breakpoint: < 768px
    applyMobileNavVisibility(navEl) {
        if (!navEl) return;
        const isMobile = window.innerWidth < 768;
        const isFullscreen = document.body.classList.contains('hide-navs');

        if (isMobile && !isFullscreen) {
            navEl.style.display = 'block';
            navEl.classList.remove('hidden');
        } else {
            navEl.style.display = 'none';
            navEl.classList.add('hidden');
        }
    },

    // ======================== AUTH STATE SYNC ========================
    syncAuthStateDisplay() {
        const isAuthed = this.state.user !== null && !this.state.user.isGuest;
        if (isAuthed && !this.state.isTestRunning) {
            if (this.inactivity) this.inactivity.startMonitoring();
        } else {
            if (this.inactivity) this.inactivity.stopMonitoring();
        }

        // Mobile Header Sync
        const mobHeaderGreeting = document.getElementById('mobile-header-greeting');
        if (mobHeaderGreeting) {
            mobHeaderGreeting.innerText = this.getTimeBasedGreeting();
        }
        const mobHeaderName = document.getElementById('mobile-header-name');
        if (mobHeaderName) {
            const effectiveName = this.getEffectiveDisplayName(this.state.user);
            mobHeaderName.innerText = effectiveName;
        }
        this.renderAvatar('mobile-header-avatar', this.state.user);

        // ---- Desktop top nav: toggle guest / auth panels ----
        const desktopGuest = document.getElementById('desktop-nav-guest');
        const desktopAuth  = document.getElementById('desktop-nav-auth');
        if (desktopGuest && desktopAuth) {
            if (isAuthed) {
                desktopGuest.classList.add('hidden');
                desktopAuth.classList.remove('hidden');
            } else {
                desktopGuest.classList.remove('hidden');
                desktopAuth.classList.add('hidden');
            }
        }

        // ---- Mobile bottom nav: Always active on mobile viewports ----
        const mobileNav = document.getElementById('mobile-nav');
        if (mobileNav) {
            this.applyMobileNavVisibility(mobileNav);
        }
        // ---- Hide "Coba Sebagai Guest" button on homepage if logged in ----
        const homeGuestBtn = document.getElementById('home-guest-btn');
        if (homeGuestBtn) {
            if (isAuthed) {
                homeGuestBtn.classList.add('hidden');
            } else {
                homeGuestBtn.classList.remove('hidden');
            }
        }
        // Account views
        if (isAuthed) {
            const unauth = document.getElementById('account-unauth');
            const auth = document.getElementById('account-auth');
            if (unauth) unauth.classList.add('hidden');
            if (auth) auth.classList.remove('hidden');

            const nameEl = document.getElementById('usr-display-name');
            const emailEl = document.getElementById('usr-display-email');
            const avatarEl = document.getElementById('usr-avatar');
            const effectiveName = this.getEffectiveDisplayName(this.state.user);
            if (nameEl) nameEl.innerText = effectiveName;
            if (emailEl) emailEl.innerText = this.state.user.email;
            this.renderAvatar('usr-avatar', this.state.user);

            const badge = document.getElementById('usr-badge');
            const disclaimer = document.getElementById('guest-disclaimer');

            if (this.state.user.isGuest) {
                if (badge) {
                    badge.className = 'bg-amber-500/10 text-amber-400 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase';
                    badge.innerText = 'Guest Mode';
                }
                if (disclaimer) disclaimer.classList.remove('hidden');
            } else {
                if (badge) {
                    badge.className = 'bg-emerald-500/10 text-emerald-400 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase';
                    badge.innerText = 'Verified User';
                }
                if (disclaimer) disclaimer.classList.add('hidden');
            }

            this.renderHistoryStatistics();
        } else {
            const unauth = document.getElementById('account-unauth');
            const auth = document.getElementById('account-auth');
            if (unauth) unauth.classList.remove('hidden');
            if (auth) auth.classList.add('hidden');
        }

        // Re-apply active nav highlight for current view
        this.updateActiveNav(this.state.currentView || 'home');
    },

    // ======================== HISTORY & STATISTICS ========================
    async loadHistory() {
        if (!this.state.user || this.state.user.isGuest) {
            this.state.history = JSON.parse(localStorage.getItem('kt_history')) || [];
            return this.state.history;
        }

        try {
            const { data, error } = await supabaseClient
                .from('test_results')
                .select('*')
                .eq('user_id', this.state.user.id)
                .order('created_at', { ascending: false });

            if (error) {
                console.error('Gagal mengambil data riwayat dari Supabase:', error);
                return this.state.history;
            }

            this.state.history = (data || []).map(row => {
                const d = new Date(row.created_at || Date.now());
                const formattedDate = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
                
                const correct = row.correct_answers || 0;
                const wrong = row.wrong_answers !== undefined && row.wrong_answers !== null 
                    ? row.wrong_answers 
                    : Math.max(0, (row.total_answered || 0) - correct);

                const rawScore = row.raw_score !== undefined && row.raw_score !== null 
                    ? Number(row.raw_score) 
                    : Math.max(0, Number((correct - (wrong * 0.25)).toFixed(2)));

                const acc = row.accuracy || 0;
                const cons = row.consistency || 100;

                const finalScore = row.score !== undefined && row.score !== null
                    ? Number(row.score)
                    : Math.round((rawScore * 0.75) + (cons * 0.15) + (acc * 0.10));

                return {
                    id: row.id,
                    date: formattedDate,
                    mode: row.mode,
                    totalAnswered: row.total_answered !== undefined && row.total_answered !== null ? row.total_answered : (row.score || 0),
                    correctAnswers: correct,
                    wrongAnswers: wrong,
                    accuracy: acc,
                    consistency: cons,
                    rawScore: rawScore,
                    score: finalScore,
                    segmentData: row.segment_data || [],
                    duration: row.duration || 60,
                    created_at: row.created_at
                };
            });

            return this.state.history;
        } catch (err) {
            console.error('Error loadHistory:', err);
            return this.state.history;
        }
    },

    async renderHistoryStatistics() {
        await this.loadHistory();
        const tbody = document.getElementById('history-table-body');
        const emptyState = document.getElementById('history-empty-state');
        const chartWrapper = document.getElementById('chart-wrapper');
        const chartFallback = document.getElementById('chart-fallback');

        if (!tbody) return;
        tbody.innerHTML = '';

        if (this.state.history.length === 0) {
            if (emptyState) emptyState.classList.remove('hidden');
            if (chartWrapper) chartWrapper.classList.add('hidden');
            if (chartFallback) {
                chartFallback.classList.remove('hidden');
                chartFallback.innerText = 'Complete more tests to view your performance trend.';
            }

            if (this.state.historyChart) {
                console.log('[HISTORY CHART DESTROYED]');
                this.state.historyChart.destroy();
                this.state.historyChart = null;
            }

            const el = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };
            el('summary-total-test', '0');
            el('summary-best-score', '0');
            el('summary-avg-acc', '0%');
            el('summary-total-time', '0');
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');

        let bestScore = 0;
        let totalAcc = 0;
        let totalSeconds = 0;

        this.state.history.forEach((h) => {
            const currentScore = h.score !== undefined ? h.score : (h.totalAnswered || 0);
            if (currentScore > bestScore) bestScore = currentScore;
            totalAcc += (h.accuracy || 0);
            totalSeconds += (h.duration || 60);

            const safeMode = this.escapeHtml(h.mode || 'Standard');
            const safeDate = this.escapeHtml(h.date || '—');

            const row = document.createElement('tr');
            row.className = 'hover:bg-slate-800/50 transition border-b border-slate-800/50';
            row.innerHTML = `
                <td class="p-3 font-medium text-slate-100">${safeDate}</td>
                <td class="p-3"><span class="bg-cyan-500/10 text-cyan-400 text-[10px] px-2 py-0.5 rounded font-bold">${safeMode}</span></td>
                <td class="p-3 text-center font-extrabold text-cyan-400">${currentScore}</td>
                <td class="p-3 text-center text-emerald-400 font-bold">${h.accuracy || 0}%</td>
                <td class="p-3 text-center text-slate-400">${h.consistency != null ? h.consistency : 100}%</td>
            `;
            tbody.appendChild(row);
        });

        const totalMinutes = Math.round(totalSeconds / 60);
        const el = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };
        el('summary-total-test', this.state.history.length);
        el('summary-best-score', bestScore);
        el('summary-avg-acc', Math.round(totalAcc / this.state.history.length) + '%');
        el('summary-total-time', totalMinutes);

        // Chronological order for chart (#1, #2, #3, ...)
        const chronologicalHistory = [...this.state.history].reverse();

        if (chronologicalHistory.length < 2) {
            if (chartWrapper) chartWrapper.classList.add('hidden');
            if (chartFallback) {
                chartFallback.classList.remove('hidden');
                chartFallback.innerText = 'Complete more tests to view your performance trend.';
            }

            if (this.state.historyChart) {
                console.log('[HISTORY CHART DESTROYED]');
                this.state.historyChart.destroy();
                this.state.historyChart = null;
            }
            return;
        }

        // Render Chart.js Line Chart
        if (chartFallback) chartFallback.classList.add('hidden');
        if (chartWrapper) chartWrapper.classList.remove('hidden');

        // Destroy existing Chart.js instance before creating a new one
        if (this.state.historyChart) {
            console.log('[HISTORY CHART DESTROYED]');
            this.state.historyChart.destroy();
            this.state.historyChart = null;
        }

        const labels = chronologicalHistory.map((_, i) => `#${i + 1}`);
        const scores = chronologicalHistory.map(h => h.score !== undefined ? h.score : (h.totalAnswered || 0));

        console.log('[HISTORY CHART DATA]', { labels, data: scores });

        const canvas = document.getElementById('history-chart-canvas');
        if (!canvas || typeof Chart === 'undefined') return;

        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 230);
        gradient.addColorStop(0, 'rgba(34, 211, 238, 0.25)');
        gradient.addColorStop(1, 'rgba(34, 211, 238, 0.0)');

        this.state.historyChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Final Score',
                    data: scores,
                    borderColor: '#22d3ee',
                    borderWidth: 3,
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.35,
                    pointBackgroundColor: '#22d3ee',
                    pointBorderColor: '#0f172a',
                    pointBorderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: '#67e8f9',
                    pointHoverBorderColor: '#0f172a',
                    pointHoverBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: '#0f172a',
                        titleColor: '#f8fafc',
                        bodyColor: '#cbd5e1',
                        borderColor: '#334155',
                        borderWidth: 1,
                        padding: 10,
                        displayColors: false,
                        callbacks: {
                            title: function(tooltipItems) {
                                const idx = tooltipItems[0].dataIndex;
                                const item = chronologicalHistory[idx];
                                return `${item.mode || 'Standard'} (${item.date || 'Sesi Tes'})`;
                            },
                            label: function(context) {
                                const idx = context.dataIndex;
                                const item = chronologicalHistory[idx];
                                return [
                                    `Final Score: ${item.score !== undefined ? item.score : item.totalAnswered}`,
                                    `Akurasi: ${item.accuracy || 0}%`,
                                    `Konsistensi: ${item.consistency || 100}%`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(51, 65, 85, 0.3)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 11, weight: 'bold' }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(51, 65, 85, 0.3)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 11, weight: 'bold' }
                        }
                    }
                }
            }
        });

        console.log('[HISTORY CHART RENDERED]');
    },

    // ======================== PROFILE ========================
    async renderProfile() {
        const user = this.state.user;
        if (!user) {
            this.navigate('account');
            return;
        }

        const el = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };

        const effectiveName = this.getEffectiveDisplayName(user);
        this.renderAvatar('profile-avatar', user);
        el('profile-username', '@' + (user.username || 'user'));
        el('profile-displayname', (user.displayName && user.displayName.trim() !== '') ? user.displayName.trim() : 'Not set');
        el('profile-bio', user.bio || 'No bio added.');
        el('profile-joindate', 'Joined July 2026');

        // Fetch single source of truth Leaderboard Rank & Statistics
        let rankText = '#—';
        if (!user.isGuest) {
            try {
                const allRanked = await this.getLeaderboardData('alltime');
                const userMatch = allRanked.find(r => r.id === user.id);
                if (userMatch) {
                    rankText = '#' + userMatch.rank;
                    user.rank = rankText;
                    user.best_standard_score = userMatch.score;
                    user.best_standard_accuracy = userMatch.accuracy;
                    user.best_standard_consistency = userMatch.consistency;
                }
            } catch (e) {
                console.error('Error fetching profile rank:', e);
            }
        }
        el('profile-rank', rankText);
        el('profile-bestscore', (user.best_standard_score || 0) > 0 ? `${user.best_standard_score} pts` : '0');

        // 2. Fetch test_results from Supabase database for average accuracy & consistency across all tests
        let totalTests = 0;
        let avgAcc = 0;
        let avgCons = 0;
        let dbResults = [];

        if (!user.isGuest) {
            try {
                const { data, error: testsErr } = await supabaseClient
                    .from('test_results')
                    .select('mode, score, total_answered, correct_answers, accuracy, consistency, created_at')
                    .eq('user_id', user.id)
                    .order('created_at', { ascending: false });

                if (!testsErr && data) {
                    dbResults = data;
                    totalTests = data.length;
                    if (totalTests > 0) {
                        const sumAcc = data.reduce((acc, row) => acc + (row.accuracy || 0), 0);
                        const sumCons = data.reduce((acc, row) => acc + (row.consistency !== undefined ? row.consistency : 100), 0);
                        avgAcc = Math.round(sumAcc / totalTests);
                        avgCons = Math.round(sumCons / totalTests);
                    }
                }
            } catch (e) {
                console.error('Error fetching test results for profile:', e);
            }
        } else {
            // Guest mode fallback using local history
            const history = this.state.history || [];
            totalTests = history.length;
            if (totalTests > 0) {
                avgAcc = Math.round(history.reduce((a, h) => a + (h.accuracy || 0), 0) / totalTests);
                avgCons = Math.round(history.reduce((a, h) => a + (h.consistency !== undefined ? h.consistency : 100), 0) / totalTests);
            }
        }

        el('profile-avgacc', avgAcc + '%');
        el('profile-avgcons', avgCons + '%');
        el('profile-totaltests', totalTests);

        // Show edit button if own profile
        const editBtn = document.getElementById('profile-edit-btn');
        if (editBtn) editBtn.classList.remove('hidden');

        // Recent results
        const recentContainer = document.getElementById('profile-recent-results');
        if (recentContainer) {
            recentContainer.innerHTML = '';
            const recent = !user.isGuest ? dbResults.slice(0, 5) : (this.state.history || []).slice(-5).reverse();
            if (recent.length === 0) {
                recentContainer.innerHTML = '<tr><td class="p-4 text-center text-slate-500 italic">Belum ada riwayat.</td></tr>';
            } else {
                recent.forEach(h => {
                    const tr = document.createElement('tr');
                    tr.className = 'hover:bg-slate-800/40 transition';
                    const safeMode = this.escapeHtml(h.mode || 'Standard Test');
                    const scoreVal = h.score !== undefined ? h.score : (h.total_answered || h.totalAnswered || 0);
                    const accVal = h.accuracy || 0;
                    const dateStr = this.escapeHtml(h.created_at ? new Date(h.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : (h.date || '—'));

                    tr.innerHTML = `
                        <td class="p-3 font-semibold text-slate-200">${safeMode}</td>
                        <td class="p-3 font-extrabold text-cyan-400 text-right">${scoreVal} pts</td>
                        <td class="p-3 text-emerald-400 text-right">${accVal}%</td>
                        <td class="p-3 text-slate-400 text-right text-xs">${dateStr}</td>
                    `;
                    recentContainer.appendChild(tr);
                });
            }
        }

        // Render Security Section (Email/Password vs Google OAuth)
        const emailSecUi = document.getElementById('profile-email-security-ui');
        const googleSecUi = document.getElementById('profile-google-security-ui');
        const isGoogle = user && (user.app_metadata?.provider === 'google' || user.is_google || (user.identities && user.identities.some(i => i.provider === 'google')));

        if (isGoogle) {
            if (emailSecUi) emailSecUi.classList.add('hidden');
            if (googleSecUi) googleSecUi.classList.remove('hidden');
        } else {
            if (emailSecUi) emailSecUi.classList.remove('hidden');
            if (googleSecUi) googleSecUi.classList.add('hidden');
        }

        // Update Compact Achievement Summary Card & Showcase
        if (this.achievements) {
            const evaluated = this.achievements.getEvaluatedList();
            const unlockedList = evaluated.filter(a => a.unlocked);
            const unlockedCount = unlockedList.length;
            const totalCount = evaluated.length;
            const globalPercentage = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;

            const counterEl = document.getElementById('profile-ach-counter');
            const percentEl = document.getElementById('profile-ach-percent');
            const barEl = document.getElementById('profile-ach-bar');

            if (counterEl) counterEl.innerText = `${unlockedCount} / ${totalCount} Unlocked`;
            if (percentEl) percentEl.innerText = `${globalPercentage}%`;
            if (barEl) barEl.style.width = `${globalPercentage}%`;

            this.achievements.renderShowcaseContainer();
        }
    },

    renderEditProfile() {
        const user = this.state.user;
        if (!user) return;

        const setVal = (id, val) => { const e = document.getElementById(id); if (e) e.value = val || ''; };
        setVal('edit-username', user.username || '');
        setVal('edit-displayname', user.displayName || '');
        setVal('edit-bio', user.bio || '');
        setVal('edit-email', user.email || '');

        this.renderAvatar('edit-avatar-preview', user);

        const removeBtn = document.getElementById('btn-remove-avatar');
        if (removeBtn) {
            if (user.avatarUrl && user.avatarUrl.trim() !== '') {
                removeBtn.classList.remove('hidden');
            } else {
                removeBtn.classList.add('hidden');
            }
        }

        const countdown = document.getElementById('edit-username-countdown');
        if (countdown) {
            if (user.usernameLastChanged) {
                const lastChanged = new Date(user.usernameLastChanged).getTime();
                const diffDays = (Date.now() - lastChanged) / (1000 * 60 * 60 * 24);
                if (diffDays < 7) {
                    const daysLeft = Math.ceil(7 - diffDays);
                    countdown.innerText = `Username dapat diubah lagi dalam ${daysLeft} hari.`;
                } else {
                    countdown.innerText = 'Username hanya dapat diubah 1 kali setiap 7 hari.';
                }
            } else {
                countdown.innerText = 'Username hanya dapat diubah 1 kali setiap 7 hari.';
            }
        }
        if (this.editUsernameValidation) {
            this.editUsernameValidation.reset();
            const editUserEl = document.getElementById('edit-username');
            if (editUserEl && editUserEl.value) {
                this.editUsernameValidation.handleInput(editUserEl.value);
            }
        }
    },

    // ======================== ACHIEVEMENTS SYSTEM ========================
    renderAchievements() {
        if (this.achievements) {
            this.achievements.render();
        }
    },

    achievements: {
        activeCategory: 'all',
        categories: [
            { id: 'all', label: 'All' },
            { id: 'getting_started', label: 'Getting Started' },
            { id: 'score', label: 'Score' },
            { id: 'testing', label: 'Testing' },
            { id: 'ranking', label: 'Ranking' },
            { id: 'accuracy', label: 'Accuracy' },
            { id: 'consistency', label: 'Consistency' },
            { id: 'streak', label: 'Streak' }
        ],
        rarityStyles: {
            common: {
                label: 'Common',
                badgeClass: 'text-slate-400 bg-slate-800/80 border-slate-700/60',
                iconBg: 'bg-slate-800/60 text-slate-300 border-slate-700/50',
                accentColor: 'text-slate-400'
            },
            rare: {
                label: 'Rare',
                badgeClass: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
                iconBg: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30 shadow-[0_0_10px_rgba(6,182,212,0.15)]',
                accentColor: 'text-cyan-400'
            },
            epic: {
                label: 'Epic',
                badgeClass: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
                iconBg: 'bg-purple-500/10 text-purple-400 border-purple-500/30 shadow-[0_0_10px_rgba(168,85,247,0.15)]',
                accentColor: 'text-purple-400'
            },
            legendary: {
                label: 'Legendary',
                badgeClass: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
                iconBg: 'bg-amber-500/10 text-amber-400 border-amber-500/30 shadow-[0_0_12px_rgba(245,158,11,0.2)]',
                accentColor: 'text-amber-400'
            }
        },
        config: [
            // Getting Started
            { id: 'first_test', title: 'First Test', desc: 'Complete your first Koran Test session', icon: 'fa-solid fa-flag-checkered', category: 'getting_started', target: 1, type: 'total_tests', rarity: 'common', unit: 'Test' },
            { id: 'first_standard', title: 'First Standard Test', desc: 'Complete a Standard mode test session', icon: 'fa-solid fa-clipboard-check', category: 'getting_started', target: 1, type: 'test_mode_standard', rarity: 'common', unit: 'Test' },
            { id: 'first_marathon', title: 'First Marathon Test', desc: 'Complete a Marathon mode test session', icon: 'fa-solid fa-person-running', category: 'getting_started', target: 1, type: 'test_mode_marathon', rarity: 'rare', unit: 'Test' },

            // Score
            { id: 'score_20', title: 'Score 20', desc: 'Achieve a score of 20 points in a test session', icon: 'fa-solid fa-star', category: 'score', target: 20, type: 'best_score', rarity: 'common', unit: 'Score' },
            { id: 'score_40', title: 'Score 40', desc: 'Achieve a score of 40 points in a test session', icon: 'fa-solid fa-medal', category: 'score', target: 40, type: 'best_score', rarity: 'common', unit: 'Score' },
            { id: 'score_60', title: 'Score 60', desc: 'Achieve a score of 60 points in a test session', icon: 'fa-solid fa-trophy', category: 'score', target: 60, type: 'best_score', rarity: 'rare', unit: 'Score' },
            { id: 'score_80', title: 'Score 80', desc: 'Achieve a score of 80 points in a test session', icon: 'fa-solid fa-crown', category: 'score', target: 80, type: 'best_score', rarity: 'epic', unit: 'Score' },
            { id: 'score_100', title: 'Score 100', desc: 'Achieve a perfect score of 100 points', icon: 'fa-solid fa-gem', category: 'score', target: 100, type: 'best_score', rarity: 'legendary', unit: 'Score' },

            // Testing
            { id: 'tests_10', title: '10 Tests', desc: 'Complete 10 test sessions in total', icon: 'fa-solid fa-vial', category: 'testing', target: 10, type: 'total_tests', rarity: 'common', unit: 'Tests' },
            { id: 'tests_25', title: '25 Tests', desc: 'Complete 25 test sessions in total', icon: 'fa-solid fa-flask', category: 'testing', target: 25, type: 'total_tests', rarity: 'rare', unit: 'Tests' },
            { id: 'tests_50', title: '50 Tests', desc: 'Complete 50 test sessions in total', icon: 'fa-solid fa-microscope', category: 'testing', target: 50, type: 'total_tests', rarity: 'epic', unit: 'Tests' },
            { id: 'tests_100', title: '100 Tests', desc: 'Complete 100 test sessions in total', icon: 'fa-solid fa-chart-line', category: 'testing', target: 100, type: 'total_tests', rarity: 'legendary', unit: 'Tests' },

            // Ranking
            { id: 'rank_100', title: 'Top 100 Rank', desc: 'Reach Top 100 on the Global Leaderboard', icon: 'fa-solid fa-ranking-star', category: 'ranking', target: 100, type: 'rank_le', rarity: 'common', unit: 'Rank' },
            { id: 'rank_50', title: 'Top 50 Rank', desc: 'Reach Top 50 on the Global Leaderboard', icon: 'fa-solid fa-award', category: 'ranking', target: 50, type: 'rank_le', rarity: 'rare', unit: 'Rank' },
            { id: 'rank_10', title: 'Top 10 Rank', desc: 'Reach Top 10 on the Global Leaderboard', icon: 'fa-solid fa-crown', category: 'ranking', target: 10, type: 'rank_le', rarity: 'epic', unit: 'Rank' },
            { id: 'rank_1', title: 'Rank #1 Champion', desc: 'Claim the #1 Champion spot on the Leaderboard', icon: 'fa-solid fa-trophy', category: 'ranking', target: 1, type: 'rank_le', rarity: 'legendary', unit: 'Rank' },

            // Accuracy
            { id: 'acc_80', title: '80% Accuracy', desc: 'Achieve 80% or higher test accuracy', icon: 'fa-solid fa-bullseye', category: 'accuracy', target: 80, type: 'best_accuracy', rarity: 'common', unit: '%' },
            { id: 'acc_90', title: '90% Accuracy', desc: 'Achieve 90% or higher test accuracy', icon: 'fa-solid fa-crosshairs', category: 'accuracy', target: 90, type: 'best_accuracy', rarity: 'rare', unit: '%' },
            { id: 'acc_95', title: '95% Accuracy', desc: 'Achieve 95% or higher test accuracy', icon: 'fa-solid fa-bullseye', category: 'accuracy', target: 95, type: 'best_accuracy', rarity: 'epic', unit: '%' },

            // Consistency
            { id: 'cons_80', title: '80% Consistency', desc: 'Maintain 80% or higher line consistency', icon: 'fa-solid fa-wave-square', category: 'consistency', target: 80, type: 'best_consistency', rarity: 'common', unit: '%' },
            { id: 'cons_90', title: '90% Consistency', desc: 'Maintain 90% or higher line consistency', icon: 'fa-solid fa-wave-square', category: 'consistency', target: 90, type: 'best_consistency', rarity: 'rare', unit: '%' },
            { id: 'cons_95', title: '95% Consistency', desc: 'Maintain 95% or higher line consistency', icon: 'fa-solid fa-wave-square', category: 'consistency', target: 95, type: 'best_consistency', rarity: 'epic', unit: '%' },

            // Streak
            { id: 'streak_3', title: '3 Days Streak', desc: 'Practice tests for 3 consecutive days', icon: 'fa-solid fa-fire', category: 'streak', target: 3, type: 'streak_days', rarity: 'common', unit: 'Days' },
            { id: 'streak_7', title: '7 Days Streak', desc: 'Practice tests for 7 consecutive days', icon: 'fa-solid fa-fire', category: 'streak', target: 7, type: 'streak_days', rarity: 'rare', unit: 'Days' },
            { id: 'streak_30', title: '30 Days Streak', desc: 'Practice tests for 30 consecutive days', icon: 'fa-solid fa-bolt', category: 'streak', target: 30, type: 'streak_days', rarity: 'legendary', unit: 'Days' }
        ],

        getEvaluatedListForUser(targetUser, tests = []) {
            const totalTests = tests.length;

            // EARLY EXIT: If user has zero test results, all achievements are locked
            if (totalTests === 0) {
                console.log('[ACHIEVEMENT INIT] Zero test results for user, all achievements locked');
                return this.config.map(item => ({
                    ...item,
                    current: 0,
                    unlocked: false,
                    percentage: 0
                }));
            }

            const stdTests = tests.filter(h => (h.mode || '').toLowerCase().includes('standard')).length;
            const marTests = tests.filter(h => (h.mode || '').toLowerCase().includes('marathon')).length;

            const historyScores = tests.map(h => h.score || 0);
            const bestScore = Math.max(...historyScores);

            const historyAcc = tests.map(h => parseFloat(h.accuracy) || 0);
            const bestAcc = Math.max(...historyAcc);

            const historyCons = tests.map(h => parseFloat(h.consistency) || 0);
            const bestCons = Math.max(...historyCons);

            const streak = targetUser?.current_streak || 0;

            return this.config.map(item => {
                let current = 0;
                let unlocked = false;

                if (item.type === 'total_tests') {
                    current = totalTests;
                    unlocked = current >= item.target;
                } else if (item.type === 'test_mode_standard') {
                    current = stdTests;
                    unlocked = current >= item.target;
                } else if (item.type === 'test_mode_marathon') {
                    current = marTests;
                    unlocked = current >= item.target;
                } else if (item.type === 'best_score') {
                    current = bestScore;
                    unlocked = current >= item.target;
                } else if (item.type === 'best_accuracy') {
                    current = Math.round(bestAcc);
                    unlocked = current >= item.target;
                } else if (item.type === 'best_consistency') {
                    current = Math.round(bestCons);
                    unlocked = current >= item.target;
                } else if (item.type === 'streak_days') {
                    current = streak;
                    unlocked = current >= item.target;
                }

                const percentage = Math.min(100, Math.round((current / item.target) * 100));

                return {
                    ...item,
                    current,
                    unlocked,
                    percentage
                };
            });
        },

        getEvaluatedList() {
            const user = app.state.user;
            const history = app.state.history || [];
            const totalTests = history.length;

            // EARLY EXIT: If user has zero test results, all achievements are locked
            // This prevents false unlocks from profile defaults or fallback values
            if (totalTests === 0) {
                const hasProfileTests = user?.best_standard_test_date != null;
                if (!hasProfileTests) {
                    console.log('[ACHIEVEMENT INIT]', {
                        userId: user?.id || 'unknown',
                        totalTestResults: 0,
                        bestScore: null,
                        accuracy: null,
                        consistency: null,
                        streak: 0,
                        unlockedAchievementIds: [],
                        completionPercent: 0
                    });
                    return this.config.map(item => ({
                        ...item,
                        current: 0,
                        unlocked: false,
                        percentage: 0
                    }));
                }
            }

            const stdTests = history.filter(h => {
                const m = (h.mode || h.test_mode || '').toLowerCase();
                return m.includes('standard');
            }).length;

            const marTests = history.filter(h => {
                const m = (h.mode || h.test_mode || '').toLowerCase();
                return m.includes('marathon');
            }).length;

            // Score: only from actual test results in history
            const historyScores = history.map(h => h.score !== undefined ? h.score : (h.total_answered || h.totalAnswered || 0));
            const bestScore = historyScores.length > 0
                ? Math.max(...historyScores, user?.best_standard_score != null ? user.best_standard_score : 0)
                : (user?.best_standard_score != null ? user.best_standard_score : 0);

            // Rank: only valid if user has test results
            const rawRank = user?.rank ? String(user.rank).replace('#', '') : '9999';
            const userRank = totalTests > 0 ? (parseInt(rawRank) || 9999) : 9999;

            // Accuracy: only from actual test results, never from profile defaults
            const historyAcc = history.map(h => parseFloat(h.accuracy) || 0);
            const bestAcc = historyAcc.length > 0
                ? Math.max(...historyAcc, user?.best_standard_accuracy != null ? parseFloat(user.best_standard_accuracy) : 0)
                : (user?.best_standard_accuracy != null ? parseFloat(user.best_standard_accuracy) : 0);

            // Consistency: only from actual test results, NEVER from profile defaults
            const historyCons = history.map(h => parseFloat(h.consistency) || 0);
            const bestCons = historyCons.length > 0
                ? Math.max(...historyCons, user?.best_standard_consistency != null ? parseFloat(user.best_standard_consistency) : 0)
                : (user?.best_standard_consistency != null ? parseFloat(user.best_standard_consistency) : 0);

            // Streak: only from actual data, no artificial defaults
            const streak = user?.current_streak || 0;

            // Debug log
            const evaluated = this.config.map(item => {
                let current = 0;
                let unlocked = false;

                if (item.type === 'total_tests') {
                    current = totalTests;
                    unlocked = current >= item.target;
                } else if (item.type === 'test_mode_standard') {
                    current = stdTests;
                    unlocked = current >= item.target;
                } else if (item.type === 'test_mode_marathon') {
                    current = marTests;
                    unlocked = current >= item.target;
                } else if (item.type === 'best_score') {
                    current = bestScore;
                    unlocked = current >= item.target;
                } else if (item.type === 'rank_le') {
                    current = userRank > 0 && userRank <= 1000 ? userRank : 0;
                    unlocked = userRank > 0 && userRank <= item.target;
                } else if (item.type === 'best_accuracy') {
                    current = Math.round(bestAcc);
                    unlocked = current >= item.target;
                } else if (item.type === 'best_consistency') {
                    current = Math.round(bestCons);
                    unlocked = current >= item.target;
                } else if (item.type === 'streak_days') {
                    current = streak;
                    unlocked = current >= item.target;
                }

                let percentage = 0;
                if (item.type === 'rank_le') {
                    percentage = unlocked ? 100 : (userRank <= 1000 ? Math.max(0, Math.round(((1000 - userRank) / (1000 - item.target)) * 100)) : 0);
                } else {
                    percentage = Math.min(100, Math.round((current / item.target) * 100));
                }

                return {
                    ...item,
                    current,
                    unlocked,
                    percentage
                };
            });

            const unlockedIds = evaluated.filter(a => a.unlocked).map(a => a.id);
            console.log('[ACHIEVEMENT INIT]', {
                userId: user?.id || 'unknown',
                totalTestResults: totalTests,
                bestScore: bestScore,
                accuracy: Math.round(bestAcc),
                consistency: Math.round(bestCons),
                streak: streak,
                unlockedAchievementIds: unlockedIds,
                completionPercent: evaluated.length > 0 ? Math.round((unlockedIds.length / evaluated.length) * 100) : 0
            });

            return evaluated;
        },

        render(categoryFilter) {
            if (categoryFilter) this.activeCategory = categoryFilter;

            const grid = document.getElementById('achievements-grid');
            const categoriesContainer = document.getElementById('achievements-categories');
            const counterText = document.getElementById('achievements-counter-text');
            const percentageText = document.getElementById('achievements-percentage-text');
            const progressBar = document.getElementById('achievements-progress-bar');

            if (!grid) return;

            const evaluated = this.getEvaluatedList();
            const unlockedCount = evaluated.filter(a => a.unlocked).length;
            const totalCount = evaluated.length;
            const globalPercentage = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;

            if (counterText) counterText.innerText = `${unlockedCount} / ${totalCount} Unlocked`;
            if (percentageText) percentageText.innerText = `${globalPercentage}% Completed`;
            if (progressBar) progressBar.style.width = `${globalPercentage}%`;

            // Render Categories
            if (categoriesContainer) {
                categoriesContainer.innerHTML = this.categories.map(cat => {
                    const isActive = cat.id === this.activeCategory;
                    return `
                        <button onclick="app.achievements.render('${cat.id}')" 
                                class="px-3.5 py-1.5 rounded-xl text-xs font-bold transition whitespace-nowrap border ${
                                    isActive
                                        ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-md shadow-cyan-500/20'
                                        : 'bg-slate-900 hover:bg-slate-800 text-slate-400 border-slate-800'
                                }">
                            ${cat.label}
                        </button>
                    `;
                }).join('');
            }

            // Filter items
            const filtered = this.activeCategory === 'all'
                ? evaluated
                : evaluated.filter(a => a.category === this.activeCategory);

            // Render Cards
            grid.innerHTML = filtered.map(item => {
                const rarity = this.rarityStyles[item.rarity] || this.rarityStyles.common;
                const isUnlocked = item.unlocked;

                return `
                    <div onclick="app.achievements.openDetailModal('${item.id}')" 
                         class="bg-slate-900 border rounded-2xl p-4 cursor-pointer transition flex flex-col justify-between group relative overflow-hidden ${
                             isUnlocked
                                 ? 'border-slate-800 hover:border-cyan-500/60 shadow-lg'
                                 : 'border-slate-800/80 opacity-60 hover:opacity-85'
                         }">
                        <!-- Status indicator -->
                        <div class="absolute top-3 right-3 text-xs">
                            ${isUnlocked 
                                ? '<span class="text-cyan-400"><i class="fa-solid fa-circle-check"></i></span>'
                                : '<span class="text-slate-600"><i class="fa-solid fa-lock"></i></span>'
                            }
                        </div>

                        <!-- Content Top -->
                        <div class="space-y-3">
                            <div class="w-12 h-12 rounded-xl border flex items-center justify-center text-xl transition group-hover:scale-105 ${
                                isUnlocked ? rarity.iconBg : 'bg-slate-800/40 text-slate-600 border-slate-800'
                            }">
                                <i class="${item.icon}"></i>
                            </div>
                            <div>
                                <span class="inline-block text-[9px] font-extrabold px-2 py-0.5 rounded uppercase tracking-wider mb-1 ${
                                    isUnlocked ? rarity.badgeClass : 'text-slate-500 bg-slate-800/50 border border-slate-700/40'
                                }">
                                    ${rarity.label}
                                </span>
                                <h4 class="font-bold text-sm leading-snug transition ${
                                    isUnlocked ? 'text-slate-100 group-hover:text-cyan-400' : 'text-slate-500'
                                }">${item.title}</h4>
                                <p class="text-[11px] text-slate-500 mt-1 line-clamp-2 leading-relaxed">${item.desc}</p>
                            </div>
                        </div>

                        <!-- Progress Bottom -->
                        <div class="mt-4 pt-3 border-t border-slate-800/60 space-y-1.5">
                            <div class="flex justify-between items-center text-[10px]">
                                <span class="text-slate-500 font-semibold">${item.current} / ${item.target} ${item.unit}</span>
                                <span class="font-bold ${isUnlocked ? 'text-cyan-400' : 'text-slate-500'}">${item.percentage}%</span>
                            </div>
                            <div class="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                                <div class="${isUnlocked ? 'bg-cyan-500' : 'bg-slate-700'} h-1.5 rounded-full transition-all duration-500" style="width: ${item.percentage}%"></div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        },

        openDetailModal(id) {
            const evaluated = this.getEvaluatedList();
            const item = evaluated.find(a => a.id === id);
            if (!item) return;

            const modal = document.getElementById('modal-achievement-detail');
            const iconWrap = document.getElementById('ach-detail-icon-wrap');
            const icon = document.getElementById('ach-detail-icon');
            const rarityEl = document.getElementById('ach-detail-rarity');
            const titleEl = document.getElementById('ach-detail-title');
            const descEl = document.getElementById('ach-detail-desc');
            const reqEl = document.getElementById('ach-detail-requirement');
            const progText = document.getElementById('ach-detail-progress-text');
            const progBar = document.getElementById('ach-detail-progress-bar');
            const statusEl = document.getElementById('ach-detail-status');

            if (!modal) return;

            const rarity = this.rarityStyles[item.rarity] || this.rarityStyles.common;

            if (iconWrap) iconWrap.className = `w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-3xl border shadow-lg transition ${rarity.iconBg}`;
            if (icon) icon.className = item.icon;
            if (rarityEl) {
                rarityEl.className = `inline-block text-[10px] font-extrabold px-2.5 py-0.5 rounded-full uppercase tracking-wider mb-1 ${rarity.badgeClass}`;
                rarityEl.innerText = rarity.label;
            }
            if (titleEl) titleEl.innerText = item.title;
            if (descEl) descEl.innerText = item.desc;
            if (reqEl) reqEl.innerText = `${item.target} ${item.unit}`;
            if (progText) progText.innerText = `${item.current} / ${item.target} ${item.unit} (${item.percentage}%)`;
            if (progBar) {
                progBar.style.width = `${item.percentage}%`;
                progBar.className = `${item.unlocked ? 'bg-cyan-500' : 'bg-slate-700'} h-2 rounded-full transition-all duration-300`;
            }
            if (statusEl) {
                statusEl.innerText = item.unlocked ? 'Unlocked' : 'Locked';
                statusEl.className = `font-bold ${item.unlocked ? 'text-cyan-400' : 'text-slate-500'}`;
            }

            modal.classList.remove('hidden');
        },

        closeDetailModal() {
            const modal = document.getElementById('modal-achievement-detail');
            if (modal) modal.classList.add('hidden');
        },

        // ======================== UNLOCK EXPERIENCE ENGINE ========================
        unlockQueue: [],
        isShowingUnlockModal: false,
        currentUnlockItem: null,
        autoCloseTimer: null,
        previousUnlockedIds: null,

        playAchievementSound() {
            // Audio hook placeholder for future sound effects
        },

        triggerConfetti() {
            try {
                const canvas = document.createElement('canvas');
                canvas.className = 'fixed inset-0 pointer-events-none z-[60]';
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;
                document.body.appendChild(canvas);

                const ctx = canvas.getContext('2d');
                const particles = [];
                const colors = ['#f59e0b', '#06b6d4', '#a855f7', '#10b981', '#ef4444'];

                for (let i = 0; i < 40; i++) {
                    particles.push({
                        x: window.innerWidth / 2,
                        y: window.innerHeight / 2 - 40,
                        vx: (Math.random() - 0.5) * 12,
                        vy: Math.random() * -10 - 4,
                        size: Math.random() * 6 + 4,
                        color: colors[Math.floor(Math.random() * colors.length)],
                        alpha: 1
                    });
                }

                let frame = 0;
                const animate = () => {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    particles.forEach(p => {
                        p.x += p.vx;
                        p.y += p.vy;
                        p.vy += 0.3;
                        p.alpha -= 0.015;
                        ctx.save();
                        ctx.globalAlpha = Math.max(0, p.alpha);
                        ctx.fillStyle = p.color;
                        ctx.fillRect(p.x, p.y, p.size, p.size);
                        ctx.restore();
                    });

                    frame++;
                    if (frame < 65) {
                        requestAnimationFrame(animate);
                    } else {
                        canvas.remove();
                    }
                };
                animate();
            } catch (e) {
                console.error('Confetti animation error:', e);
            }
        },

        captureBaseline() {
            const evaluated = this.getEvaluatedList();
            this.previousUnlockedIds = evaluated.filter(a => a.unlocked).map(a => a.id);
        },

        checkUnlocksAfterTest() {
            if (!this.previousUnlockedIds) {
                this.captureBaseline();
            }

            const beforeList = this.previousUnlockedIds || [];
            const evaluated = this.getEvaluatedList();
            const currentUnlockedIds = evaluated.filter(a => a.unlocked).map(a => a.id);

            // Detect newly unlocked achievements
            const newlyUnlocked = evaluated.filter(a => a.unlocked && !beforeList.includes(a.id));

            console.log('[ACHIEVEMENT]', {
                previousCount: beforeList.length,
                newCount: currentUnlockedIds.length,
                unlockedIds: newlyUnlocked.map(a => a.id),
                unlockQueue: newlyUnlocked.map(a => a.title)
            });

            // Update baseline unlocked IDs
            this.previousUnlockedIds = currentUnlockedIds;

            // Immediately update Profile Summary Card
            if (app.renderProfile) {
                app.renderProfile();
            }

            if (newlyUnlocked.length > 0) {
                this.unlockQueue.push(...newlyUnlocked);
                this.processUnlockQueue();
            }
        },

        processUnlockQueue() {
            if (this.isShowingUnlockModal || this.unlockQueue.length === 0) return;

            const item = this.unlockQueue.shift();
            this.currentUnlockItem = item;
            this.isShowingUnlockModal = true;

            this.playAchievementSound();

            if (item.rarity === 'legendary') {
                this.triggerConfetti();
            }

            const modal = document.getElementById('modal-achievement-unlocked');
            const iconWrap = document.getElementById('ach-unlock-icon-wrap');
            const icon = document.getElementById('ach-unlock-icon');
            const rarityEl = document.getElementById('ach-unlock-rarity');
            const titleEl = document.getElementById('ach-unlock-title');
            const descEl = document.getElementById('ach-unlock-desc');

            if (!modal) return;

            const rarity = this.rarityStyles[item.rarity] || this.rarityStyles.common;

            if (iconWrap) iconWrap.className = `w-20 h-20 mx-auto rounded-2xl flex items-center justify-center text-4xl border shadow-xl transition-transform duration-500 scale-105 ${rarity.iconBg}`;
            if (icon) icon.className = item.icon;
            if (rarityEl) {
                rarityEl.className = `inline-block text-[10px] font-extrabold px-2.5 py-0.5 rounded-full uppercase tracking-wider ${rarity.badgeClass}`;
                rarityEl.innerText = rarity.label;
            }
            if (titleEl) titleEl.innerText = item.title;
            if (descEl) descEl.innerText = item.desc;

            modal.classList.remove('hidden');

            // Auto close after 3 seconds
            if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
            this.autoCloseTimer = setTimeout(() => {
                this.closeUnlockModal();
            }, 3000);
        },

        closeUnlockModal() {
            if (this.autoCloseTimer) {
                clearTimeout(this.autoCloseTimer);
                this.autoCloseTimer = null;
            }

            const modal = document.getElementById('modal-achievement-unlocked');
            if (modal) modal.classList.add('hidden');

            const item = this.currentUnlockItem;
            if (item) {
                app.toast.show(`🏆 New Achievement Unlocked: ${item.title}`, 'success', 2500);
            }

            this.isShowingUnlockModal = false;
            this.currentUnlockItem = null;

            // Process next unlocked achievement in queue after a short delay
            setTimeout(() => {
                this.processUnlockQueue();
            }, 300);
        },

        // ======================== ACHIEVEMENT SHOWCASE ENGINE ========================
        showcaseSelectedIds: [],
        initialShowcaseIds: [],
        pickerCategory: 'all',

        circularRarityStyles: {
            common: 'bg-slate-800/80 text-slate-300 border-slate-700/60 shadow-[0_0_8px_rgba(148,163,184,0.15)]',
            rare: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/40 shadow-[0_0_12px_rgba(6,182,212,0.25)]',
            epic: 'bg-purple-500/15 text-purple-400 border-purple-500/40 shadow-[0_0_12px_rgba(168,85,247,0.25)]',
            legendary: 'bg-amber-500/15 text-amber-400 border-amber-500/40 shadow-[0_0_14px_rgba(245,158,11,0.3)]'
        },

        renderShowcaseContainer(containerId = 'profile-showcase-container') {
            const container = document.getElementById(containerId);
            if (!container) return;

            const user = app.state.user;
            console.log('[SHOWCASE RENDER]', user?.achievement_showcase);
            const evaluated = this.getEvaluatedList();
            const unlockedList = evaluated.filter(a => a.unlocked);
            const unlockedIds = unlockedList.map(a => a.id);

            // Extract user.achievement_showcase
            let rawList = [];
            if (user && user.achievement_showcase) {
                const scData = typeof user.achievement_showcase === 'string'
                    ? JSON.parse(user.achievement_showcase)
                    : user.achievement_showcase;
                if (scData && Array.isArray(scData.showcase)) {
                    rawList = scData.showcase;
                }
            }

            // Validate: must exist and be currently unlocked, max 4
            const validSelectedIds = rawList.filter(id => unlockedIds.includes(id)).slice(0, 4);

            if (validSelectedIds.length === 0) {
                // Empty State
                container.className = "w-full";
                container.innerHTML = `
                    <div class="w-full text-center py-4 px-4 bg-slate-950/60 border border-slate-800/80 rounded-xl space-y-2">
                        <div class="text-2xl">🏆</div>
                        <p class="text-xs font-extrabold text-slate-200">No Achievement Showcase</p>
                        <p class="text-[11px] text-slate-400">Choose up to four achievements to personalize your profile.</p>
                        <button onclick="app.achievements.openShowcaseModal()" class="text-xs font-extrabold text-cyan-400 hover:text-cyan-300 transition inline-flex items-center gap-1 mt-1 focus:outline-none focus:ring-2 focus:ring-cyan-400 rounded">
                            Choose Showcase →
                        </button>
                    </div>
                `;
            } else {
                // Render up to 4 selected showcase achievement circular badges
                const selectedItems = validSelectedIds.map(id => evaluated.find(a => a.id === id)).filter(Boolean);

                container.className = "bg-slate-950/60 border border-slate-800/80 p-4 rounded-xl flex items-center justify-between w-full";
                container.innerHTML = `
                    <div class="flex-1 flex items-center justify-center gap-4 sm:gap-5 my-1">
                        ${selectedItems.map(item => {
                            const circStyle = this.circularRarityStyles[item.rarity] || this.circularRarityStyles.common;
                            return `
                                <div onclick="app.toast.show('🏆 ${item.title}: ${item.desc} | Target: ${item.target} ${item.unit}', 'info', 3000)" 
                                     title="${item.title}\n${item.desc}\nTarget: ${item.target} ${item.unit}\nRarity: ${item.rarity.toUpperCase()}" 
                                     tabindex="0" role="button" aria-label="${item.title}"
                                     class="w-12 h-12 sm:w-13 sm:h-13 rounded-full border flex items-center justify-center text-xl cursor-pointer transition-all duration-300 transform hover:scale-110 hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-cyan-400 ${circStyle}">
                                    <i class="${item.icon}"></i>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    <button onclick="app.achievements.openShowcaseModal()" aria-label="Edit Showcase" class="text-xs font-bold text-slate-400 hover:text-cyan-400 transition p-1.5 rounded-lg hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400">
                        <i class="fa-solid fa-pen-to-square text-sm"></i>
                    </button>
                `;
            }
        },

        openShowcaseModal() {
            const modal = document.getElementById('modal-showcase-picker');
            const grid = document.getElementById('showcase-picker-grid');
            if (!modal || !grid) return;

            const user = app.state.user;
            const evaluated = this.getEvaluatedList();
            const unlockedList = evaluated.filter(a => a.unlocked);
            const unlockedIds = unlockedList.map(a => a.id);

            // Read current valid selected showcase IDs
            let rawList = [];
            if (user && user.achievement_showcase) {
                const scData = typeof user.achievement_showcase === 'string'
                    ? JSON.parse(user.achievement_showcase)
                    : user.achievement_showcase;
                if (scData && Array.isArray(scData.showcase)) {
                    rawList = scData.showcase;
                }
            }

            this.showcaseSelectedIds = rawList.filter(id => unlockedIds.includes(id)).slice(0, 4);
            console.log('[SHOWCASE MODAL]', this.showcaseSelectedIds);
            this.initialShowcaseIds = [...this.showcaseSelectedIds];
            this.pickerCategory = 'all';

            this.renderShowcasePicker();
            modal.classList.remove('hidden');
        },

        clearShowcaseSelection() {
            this.showcaseSelectedIds = [];
            this.renderShowcasePicker();
        },

        handleDragStart(e, index) {
            e.dataTransfer.setData('text/plain', index);
            e.dataTransfer.effectAllowed = 'move';
        },

        handleDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        },

        handleDrop(e, targetIndex) {
            e.preventDefault();
            const sourceIndex = parseInt(e.dataTransfer.getData('text/plain'));
            if (!isNaN(sourceIndex) && sourceIndex !== targetIndex && sourceIndex < this.showcaseSelectedIds.length && targetIndex < this.showcaseSelectedIds.length) {
                const temp = this.showcaseSelectedIds[sourceIndex];
                this.showcaseSelectedIds[sourceIndex] = this.showcaseSelectedIds[targetIndex];
                this.showcaseSelectedIds[targetIndex] = temp;
                this.renderShowcasePicker();
            }
        },

        moveShowcaseItem(fromIndex, toIndex) {
            if (toIndex >= 0 && toIndex < this.showcaseSelectedIds.length) {
                const temp = this.showcaseSelectedIds[fromIndex];
                this.showcaseSelectedIds[fromIndex] = this.showcaseSelectedIds[toIndex];
                this.showcaseSelectedIds[toIndex] = temp;
                this.renderShowcasePicker();
            }
        },

        renderLivePreview() {
            const previewContainer = document.getElementById('showcase-live-preview');
            if (!previewContainer) return;

            const evaluated = this.getEvaluatedList();
            const totalSlots = 4;
            let previewHtml = '';

            for (let i = 0; i < totalSlots; i++) {
                const itemId = this.showcaseSelectedIds[i];
                if (itemId) {
                    const item = evaluated.find(a => a.id === itemId);
                    if (item) {
                        const circStyle = this.circularRarityStyles[item.rarity] || this.circularRarityStyles.common;
                        previewHtml += `
                            <div draggable="true"
                                 ondragstart="app.achievements.handleDragStart(event, ${i})"
                                 ondragover="app.achievements.handleDragOver(event)"
                                 ondrop="app.achievements.handleDrop(event, ${i})"
                                 title="Slot ${i + 1}: ${item.title} (Drag to reorder)" 
                                 class="relative w-9 h-9 sm:w-10 sm:h-10 rounded-full border flex items-center justify-center text-sm sm:text-base cursor-grab active:cursor-grabbing transition-all duration-300 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-cyan-400 ${circStyle}">
                                <i class="${item.icon}"></i>
                                <span class="absolute -top-1 -right-1 bg-cyan-500 text-slate-950 text-[9px] font-black w-3.5 h-3.5 rounded-full flex items-center justify-center shadow-md">${i + 1}</span>
                            </div>
                        `;
                    }
                } else {
                    previewHtml += `
                        <div class="w-9 h-9 sm:w-10 sm:h-10 rounded-full border-2 border-dashed border-slate-800/80 text-slate-600 text-sm font-bold flex items-center justify-center">
                            +
                        </div>
                    `;
                }
            }

            previewContainer.innerHTML = previewHtml;
        },

        renderShowcasePicker(catFilter) {
            if (catFilter) this.pickerCategory = catFilter;

            const grid = document.getElementById('showcase-picker-grid');
            const counter = document.getElementById('showcase-picker-counter');
            const categoriesContainer = document.getElementById('showcase-picker-categories');
            const saveBtn = document.getElementById('btn-save-showcase');
            if (!grid) return;

            if (catFilter) {
                grid.scrollTop = 0;
            }

            // Render Live Profile Preview
            this.renderLivePreview();

            if (counter) counter.innerText = `${this.showcaseSelectedIds.length} / 4`;

            // Check if changes were made to toggle Save Changes button
            const isChanged = JSON.stringify(this.showcaseSelectedIds) !== JSON.stringify(this.initialShowcaseIds);
            if (saveBtn) {
                saveBtn.disabled = !isChanged;
            }

            // Render Category Filter Tabs
            if (categoriesContainer) {
                categoriesContainer.innerHTML = this.categories.map(cat => {
                    const isActive = cat.id === this.pickerCategory;
                    return `
                        <button onclick="app.achievements.renderShowcasePicker('${cat.id}')" 
                                class="px-3.5 py-1.5 rounded-xl text-xs font-extrabold transition whitespace-nowrap border shrink-0 focus:outline-none focus:ring-2 focus:ring-cyan-400 ${
                                    isActive
                                        ? 'bg-cyan-500 text-slate-950 border-cyan-400 shadow-sm shadow-cyan-500/20'
                                        : 'bg-slate-950 hover:bg-slate-800 text-slate-400 border-slate-800'
                                }">
                            ${cat.label}
                        </button>
                    `;
                }).join('');
            }

            const evaluated = this.getEvaluatedList();
            const filtered = this.pickerCategory === 'all'
                ? evaluated
                : evaluated.filter(a => a.category === this.pickerCategory);

            grid.innerHTML = filtered.map(item => {
                const rarity = this.rarityStyles[item.rarity] || this.rarityStyles.common;
                const isUnlocked = item.unlocked;
                const selectedIndex = this.showcaseSelectedIds.indexOf(item.id);
                const isSelected = selectedIndex > -1;

                const orderSymbols = ['①', '②', '③', '④'];
                const orderBadge = isSelected ? orderSymbols[selectedIndex] : '';

                return `
                    <div onclick="${isUnlocked ? `app.achievements.toggleShowcaseSelection('${item.id}')` : ''}"
                         tabindex="${isUnlocked ? '0' : '-1'}"
                         role="button"
                         title="${item.title}: ${item.desc}\nTarget: ${item.target} ${item.unit}"
                         aria-selected="${isSelected}"
                         aria-disabled="${!isUnlocked}"
                         onkeydown="${isUnlocked ? `if(event.key==='Enter'||event.key===' '){event.preventDefault();app.achievements.toggleShowcaseSelection('${item.id}');}` : ''}"
                         class="bg-slate-900/90 border rounded-xl p-3 flex flex-col justify-between transition-all duration-200 select-none relative overflow-hidden group h-[108px] w-full min-w-0 focus:outline-none focus:ring-2 focus:ring-cyan-400 ${
                             isUnlocked
                                 ? (isSelected
                                     ? 'border-cyan-400 bg-cyan-500/10 ring-1 ring-cyan-400 shadow-[0_0_12px_rgba(6,182,212,0.2)] cursor-pointer scale-[1.01]'
                                     : 'border-slate-800 hover:border-cyan-500/50 hover:bg-slate-800/80 cursor-pointer hover:-translate-y-0.5')
                                 : 'border-slate-800/70 bg-slate-950/60 opacity-75 hover:opacity-90 cursor-not-allowed'
                         }">
                        
                        <!-- Top Row: Icon, Rarity Badge & Selection Indicator -->
                        <div class="flex items-center justify-between gap-1.5">
                            <div class="flex items-center space-x-2 min-w-0">
                                <div class="w-8 h-8 rounded-lg border flex items-center justify-center text-base transition group-hover:scale-105 shrink-0 ${
                                    isUnlocked ? rarity.iconBg : 'bg-slate-800/60 text-slate-500 border-slate-700/60'
                                }">
                                    <i class="${item.icon}"></i>
                                </div>
                                <span class="inline-block text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0 ${
                                    isUnlocked ? rarity.badgeClass : 'text-slate-400 bg-slate-800/70 border border-slate-700/50'
                                }">
                                    ${rarity.label}
                                </span>
                            </div>

                            <div class="shrink-0">
                                ${isUnlocked ? (
                                    isSelected 
                                        ? `<span class="bg-cyan-500 text-slate-950 text-[10px] font-black px-1.5 py-0.5 rounded-full flex items-center gap-0.5 shadow-sm">${orderBadge} <i class="fa-solid fa-circle-check text-[9px]"></i></span>`
                                        : '<span class="text-slate-600 group-hover:text-slate-400 text-xs"><i class="fa-regular fa-circle"></i></span>'
                                ) : (
                                    '<span class="text-slate-500 text-xs"><i class="fa-solid fa-lock text-[10px]"></i></span>'
                                )}
                            </div>
                        </div>

                        <!-- Title -->
                        <h4 class="font-extrabold text-xs leading-tight truncate mt-1 ${
                            isUnlocked ? (isSelected ? 'text-cyan-300' : 'text-slate-100') : 'text-slate-400'
                        }">${item.title}</h4>

                        <!-- Bottom Progress & Requirement -->
                        <div class="pt-1.5 border-t border-slate-800/80 flex items-center justify-between text-[10px]">
                            <span class="text-slate-400 font-semibold truncate max-w-[85px]">
                                ${item.target} ${item.unit}
                            </span>
                            <span class="font-extrabold ${isUnlocked ? 'text-cyan-400' : 'text-slate-400'}">
                                ${item.current}/${item.target} (${item.percentage}%)
                            </span>
                        </div>
                    </div>
                `;
            }).join('');
        },

        toggleShowcaseSelection(id) {
            const idx = this.showcaseSelectedIds.indexOf(id);
            if (idx > -1) {
                this.showcaseSelectedIds.splice(idx, 1);
            } else {
                if (this.showcaseSelectedIds.length >= 4) {
                    app.toast.show('Maximum of four showcase achievements.', 'warning', 2500);
                    return;
                }
                this.showcaseSelectedIds.push(id);
            }
            this.renderShowcasePicker();
        },

        closeShowcaseModal() {
            const modal = document.getElementById('modal-showcase-picker');
            if (modal) modal.classList.add('hidden');
        },

        async saveShowcase() {
            const user = app.state.user;
            if (!user) return;

            const evaluated = this.getEvaluatedList();
            const unlockedIds = evaluated.filter(a => a.unlocked).map(a => a.id);

            // Validate: only unlocked items, max 4
            const validSelected = this.showcaseSelectedIds.filter(id => unlockedIds.includes(id)).slice(0, 4);

            const showcaseObj = {
                featured: user.achievement_showcase?.featured || null,
                showcase: validSelected,
                updated_at: new Date().toISOString()
            };

            // Save to Supabase if authenticated user
            if (!user.isGuest && user.id) {
                try {
                    const { error } = await supabaseClient
                        .from('profiles')
                        .update({ achievement_showcase: showcaseObj })
                        .eq('id', user.id);

                    if (error) {
                        console.error('Error updating achievement_showcase in Supabase:', error);
                    }
                } catch (e) {
                    console.error('Error saving achievement_showcase:', e);
                }
            }

            // Update local state and storage
            app.state.user.achievement_showcase = showcaseObj;
            localStorage.setItem('kt_user', JSON.stringify(app.state.user));

            this.closeShowcaseModal();
            this.renderShowcaseContainer();
            app.toast.show('Achievement showcase updated successfully!', 'success', 2500);
        }
    },

    // ======================== GLOBAL PROTECTION ========================
    bindGlobalProtection() {
        window.addEventListener('beforeunload', (e) => {
            if (this.state.isTestRunning) {
                e.preventDefault();
                e.returnValue = 'Tes sedang berlangsung. Apakah Anda yakin ingin keluar?';
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && this.state.isTestRunning) {
                this.toast.show('Perhatian! Anda meninggalkan halaman tes. Fokuskan kembali.', 'warning');
            }
        });

        // Physical keyboard support
        document.addEventListener('keydown', (e) => {
            // Modal Escape key support
            if (e.key === 'Escape') {
                app.actions.closeAuthModal();
                app.actions.closeInfoModal();
                if (app.achievements) app.achievements.closeDetailModal();
                if (app.leaderboard) app.leaderboard.closeProfilePreview();
            }

            if (app.state.isTestRunning && e.key >= '0' && e.key <= '9') {
                const tag = document.activeElement ? document.activeElement.tagName : '';
                if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable)) return;
                app.actions.inputDigit(parseInt(e.key));
            }
        });
    },

    // ======================== EMAIL VERIFICATION WAITING & VERIFY PAGE ========================
    async initVerifyEmailView() {
        const loadingState = document.getElementById('verify-loading-state');
        const successState = document.getElementById('verify-success-state');
        const errorState = document.getElementById('verify-error-state');
        const errorMsgEl = document.getElementById('verify-error-message');
        const waitingState = document.getElementById('verify-waiting-state');

        // Helper to reset view states
        const showState = (targetState) => {
            if (loadingState) loadingState.classList.add('hidden');
            if (successState) successState.classList.add('hidden');
            if (errorState) errorState.classList.add('hidden');
            if (waitingState) waitingState.classList.add('hidden');

            if (targetState) targetState.classList.remove('hidden');
        };

        // Parse search params & hash params
        const searchParams = new URLSearchParams(window.location.search);
        let hashString = window.location.hash;
        if (hashString.startsWith('#')) hashString = hashString.slice(1);
        if (hashString.startsWith('/')) hashString = hashString.slice(1);
        const hashParams = new URLSearchParams(hashString);

        const tokenHash = searchParams.get('token_hash') || hashParams.get('token_hash');
        const type = searchParams.get('type') || hashParams.get('type') || 'signup';
        const code = searchParams.get('code') || hashParams.get('code');
        const errorParam = searchParams.get('error') || hashParams.get('error') || searchParams.get('error_description') || hashParams.get('error_description');

        console.log('[VERIFY-EMAIL] Params detected:', { tokenHash: !!tokenHash, code: !!code, type, errorParam: !!errorParam });

        // CASE 1: URL contains explicit error (e.g. link expired, access denied)
        if (errorParam) {
            console.warn('[VERIFY-EMAIL] Error param in URL:', errorParam);
            showState(errorState);
            if (errorMsgEl) {
                const desc = decodeURIComponent(errorParam).toLowerCase();
                if (desc.includes('expired') || desc.includes('otp_expired')) {
                    errorMsgEl.innerText = 'This email verification link has expired. Please request a new verification link.';
                } else {
                    errorMsgEl.innerText = 'The verification link is invalid or corrupted. Please request a new link.';
                }
            }
            return;
        }

        // CASE 2: URL contains token_hash (Supabase PKCE / OTP confirmation)
        if (tokenHash) {
            showState(loadingState);
            try {
                console.log('[VERIFY-EMAIL] Executing verifyOtp for type:', type);
                const { data, error } = await supabaseClient.auth.verifyOtp({
                    token_hash: tokenHash,
                    type: type
                });

                if (error) {
                    console.error('[VERIFY-EMAIL] verifyOtp error:', error);
                    if (error.message && error.message.toLowerCase().includes('already')) {
                        app.handleVerificationSuccess(data?.user?.email);
                        return;
                    }

                    showState(errorState);
                    if (errorMsgEl) {
                        if (error.message.toLowerCase().includes('expired')) {
                            errorMsgEl.innerText = 'This email verification link has expired. Please request a new verification link.';
                        } else {
                            errorMsgEl.innerText = error.message || 'Verification failed. The link may be invalid or expired.';
                        }
                    }
                } else {
                    console.log('[VERIFY-EMAIL] verifyOtp success!');
                    const verifiedEmail = data?.user?.email || data?.session?.user?.email;
                    app.handleVerificationSuccess(verifiedEmail);
                }
            } catch (err) {
                console.error('[VERIFY-EMAIL] Unexpected verifyOtp exception:', err);
                showState(errorState);
                if (errorMsgEl) errorMsgEl.innerText = 'Network or connection error. Please try again.';
            }
            return;
        }

        // CASE 3: URL contains PKCE auth code
        if (code) {
            showState(loadingState);
            try {
                console.log('[VERIFY-EMAIL] Executing exchangeCodeForSession');
                const { data, error } = await supabaseClient.auth.exchangeCodeForSession(code);
                if (error) {
                    console.error('[VERIFY-EMAIL] exchangeCodeForSession error:', error);
                    showState(errorState);
                    if (errorMsgEl) errorMsgEl.innerText = error.message || 'Invalid or expired verification code.';
                } else {
                    console.log('[VERIFY-EMAIL] exchangeCodeForSession success!');
                    app.handleVerificationSuccess(data?.user?.email);
                }
            } catch (err) {
                console.error('[VERIFY-EMAIL] Unexpected exchangeCode exception:', err);
                showState(errorState);
                if (errorMsgEl) errorMsgEl.innerText = 'Network error during verification.';
            }
            return;
        }

        // CASE 4: Active session or auto-processed hash session
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session?.user?.email_confirmed_at || session?.user?.confirmed_at) {
                console.log('[VERIFY-EMAIL] User is already confirmed!');
                app.handleVerificationSuccess(session.user.email);
                return;
            }
        } catch (e) {
            console.log('[VERIFY-EMAIL] Session check error:', e);
        }

        // CASE 5: Default Waiting State (User just completed signup and is waiting to open email)
        showState(waitingState);
        const email = app.state.unverifiedEmail || sessionStorage.getItem('kt_pending_verification_email');
        const emailEl = document.getElementById('verify-email-address');

        if (!email) {
            if (emailEl) emailEl.innerText = 'Registration session not found';
            const btn = document.getElementById('btn-verify-resend');
            if (btn) btn.disabled = true;
            app.toast.show('Registration session not found. Please register again.', 'warning');
        } else {
            if (emailEl) emailEl.innerText = email;
        }

        // Check for active resend cooldown in localStorage (persistence across reload)
        const cooldownUntil = parseInt(localStorage.getItem('kt_resend_cooldown_until') || '0', 10);
        const remainingSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);

        if (remainingSeconds > 0) {
            app.startVerifyPageResendCooldown(remainingSeconds);
        } else {
            localStorage.removeItem('kt_resend_cooldown_until');
            const btn = document.getElementById('btn-verify-resend');
            const textEl = document.getElementById('verify-resend-cooldown');
            if (btn && email) btn.disabled = false;
            if (textEl) {
                textEl.classList.add('hidden');
                textEl.innerText = '';
            }
        }

        app.state.isEmailVerificationSuccess = false;
        app.startEmailVerificationPolling();
    },

    startEmailVerificationPolling() {
        app.stopEmailVerificationPolling();

        const checkVerificationStatus = async () => {
            if (app.state.isEmailVerificationSuccess) return;

            const statusText = document.getElementById('verify-status-text');
            const spinner = document.getElementById('verify-status-spinner');
            const spinnerBadge = document.getElementById('verify-spinner-badge');

            // Check network connection
            if (!navigator.onLine) {
                if (statusText) statusText.innerText = 'Waiting for connection...';
                if (spinner) spinner.classList.add('hidden');
                if (spinnerBadge) spinnerBadge.classList.add('hidden');
                return;
            }

            if (statusText) statusText.innerText = 'Waiting for email verification...';
            if (spinner) spinner.classList.remove('hidden');
            if (spinnerBadge) spinnerBadge.classList.remove('hidden');

            try {
                // Check current session
                const { data: { session } } = await supabaseClient.auth.getSession();
                if (session?.user?.email_confirmed_at || session?.user?.confirmed_at) {
                    app.handleVerificationSuccess(session.user.email);
                    return;
                }

                // Check user object
                const { data: { user } } = await supabaseClient.auth.getUser();
                if (user?.email_confirmed_at || user?.confirmed_at) {
                    app.handleVerificationSuccess(user.email || app.state.unverifiedEmail);
                    return;
                }
            } catch (e) {
                console.log('[VERIFY POLLING] Check attempt:', e);
            }
        };

        // Immediate initial check
        checkVerificationStatus();

        // Poll every 3 seconds
        app.state.verificationPollingInterval = setInterval(checkVerificationStatus, 3000);
    },

    stopEmailVerificationPolling() {
        if (app.state.verificationPollingInterval) {
            clearInterval(app.state.verificationPollingInterval);
            app.state.verificationPollingInterval = null;
        }
    },

    async handleVerificationSuccess(verifiedEmail) {
        if (app.state.isEmailVerificationSuccess) return;
        app.state.isEmailVerificationSuccess = true;

        app.stopEmailVerificationPolling();

        const loadingState = document.getElementById('verify-loading-state');
        const waitingState = document.getElementById('verify-waiting-state');
        const errorState = document.getElementById('verify-error-state');
        const successState = document.getElementById('verify-success-state');

        if (loadingState) loadingState.classList.add('hidden');
        if (waitingState) waitingState.classList.add('hidden');
        if (errorState) errorState.classList.add('hidden');
        if (successState) successState.classList.remove('hidden');

        const emailToUse = verifiedEmail || app.state.unverifiedEmail || sessionStorage.getItem('kt_pending_verification_email');
        if (emailToUse) {
            sessionStorage.setItem('kt_post_register_email', emailToUse);
            sessionStorage.setItem('kt_verification_just_completed', 'true');
        }

        sessionStorage.removeItem('kt_pending_verification_email');
        sessionStorage.removeItem('kt_pending_registration_username');
        app.state.unverifiedEmail = null;

        app.toast.show('Email verified successfully!', 'success');

        setTimeout(() => {
            // Replace browser history entry from /verify-email to /#login
            if (window.location.pathname.includes('verify-email')) {
                const targetUrl = window.location.origin + '/#login';
                try {
                    window.history.replaceState(null, '', targetUrl);
                } catch (e) {
                    console.log('[HISTORY REPLACE ERROR]', e);
                }
            }
            app.navigate('login', true);
        }, 1000);
    },

    openEmailApp() {
        const email = app.state.unverifiedEmail || sessionStorage.getItem('kt_pending_verification_email') || '';
        const domain = email.includes('@') ? email.split('@')[1].toLowerCase() : '';

        let webmailUrl = null;
        if (domain === 'gmail.com' || domain === 'googlemail.com') {
            webmailUrl = 'https://mail.google.com';
        } else if (domain === 'yahoo.com' || domain === 'yahoo.co.id' || domain.includes('yahoo')) {
            webmailUrl = 'https://mail.yahoo.com';
        } else if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'msn.com') {
            webmailUrl = 'https://outlook.live.com';
        } else if (domain === 'icloud.com' || domain === 'me.com') {
            webmailUrl = 'https://www.icloud.com/mail';
        } else if (domain === 'proton.me' || domain === 'protonmail.com') {
            webmailUrl = 'https://mail.proton.me';
        }

        if (webmailUrl) {
            window.open(webmailUrl, '_blank');
        } else {
            try {
                window.location.href = 'mailto:';
            } catch (e) {
                console.log('[OPEN EMAIL APP] Fallback failed:', e);
            }
        }
    },

    changeEmailFromVerify() {
        app.stopEmailVerificationPolling();
        const username = sessionStorage.getItem('kt_pending_registration_username') || app.state.pendingRegistrationUsername || '';
        const email = sessionStorage.getItem('kt_pending_verification_email') || app.state.unverifiedEmail || '';

        sessionStorage.removeItem('kt_pending_verification_email');
        sessionStorage.removeItem('kt_pending_registration_username');
        app.state.unverifiedEmail = null;

        app.navigate('register');

        setTimeout(() => {
            const nameInput = document.getElementById('reg-name');
            const emailInput = document.getElementById('reg-email');
            const pwdInput = document.getElementById('reg-pwd');

            if (nameInput && username) nameInput.value = username;
            if (emailInput && email) emailInput.value = email;
            if (pwdInput) pwdInput.value = '';
        }, 200);
    },

    async resendVerificationFromPage() {
        const email = app.state.unverifiedEmail || sessionStorage.getItem('kt_pending_verification_email');
        if (!email) {
            app.toast.show('Registration session not found. Please register again.', 'error');
            const btn = document.getElementById('btn-verify-resend');
            if (btn) btn.disabled = true;
            return;
        }

        // Prevent duplicate API requests if already in progress
        if (app.state.isResendingVerification) return;

        // Check if currently in active cooldown
        const cooldownUntil = parseInt(localStorage.getItem('kt_resend_cooldown_until') || '0', 10);
        const remainingSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
        if (remainingSeconds > 0) {
            app.toast.show(`Please wait ${remainingSeconds} seconds before requesting another email.`, 'warning');
            app.startVerifyPageResendCooldown(remainingSeconds);
            return;
        }

        // Pre-resend check: Verify if email is already confirmed
        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session?.user?.email_confirmed_at || session?.user?.confirmed_at) {
                app.toast.show('Your email has already been verified.', 'info');
                app.handleVerificationSuccess(session.user.email || email);
                return;
            }
            const { data: { user } } = await supabaseClient.auth.getUser();
            if (user?.email_confirmed_at || user?.confirmed_at) {
                app.toast.show('Your email has already been verified.', 'info');
                app.handleVerificationSuccess(user.email || email);
                return;
            }
        } catch (e) {
            console.log('[RESEND] Pre-check verification error:', e);
        }

        const btn = document.getElementById('btn-verify-resend');
        let originalBtnHtml = '';
        if (btn) {
            btn.disabled = true;
            originalBtnHtml = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-xs"></i> <span>Sending...</span>';
        }

        app.state.isResendingVerification = true;

        const verifyRedirectUrl = window.location.origin.includes('korantest.my.id') 
            ? 'https://www.korantest.my.id/verify-email' 
            : `${window.location.origin}/verify-email`;

        try {
            console.log('[RESEND VERIFICATION PAGE] Sending to:', email);
            const { error } = await supabaseClient.auth.resend({
                type: 'signup',
                email: email,
                options: {
                    emailRedirectTo: verifyRedirectUrl
                }
            });

            app.state.isResendingVerification = false;

            if (error) {
                console.error('[RESEND VERIFICATION FAILED]', error);
                if (btn) btn.innerHTML = originalBtnHtml || 'Resend Verification Email';

                const msg = error.message ? error.message.toLowerCase() : '';
                if (msg.includes('rate limit') || msg.includes('too many') || error.status === 429) {
                    app.toast.show('Too many requests. Please wait a moment before trying again.', 'warning');
                } else if (msg.includes('already confirmed') || msg.includes('already verified')) {
                    app.toast.show('Your email has already been verified.', 'info');
                    app.handleVerificationSuccess(email);
                    return;
                } else if (msg.includes('invalid') || msg.includes('not found')) {
                    app.toast.show('Invalid email address or registration session expired.', 'error');
                } else {
                    app.toast.show('Failed to send verification email. Please try again later.', 'error');
                }

                // Start cooldown to prevent rapid spam clicking
                app.startVerifyPageResendCooldown(60);
                return;
            }

            if (btn) btn.innerHTML = originalBtnHtml || 'Resend Verification Email';
            app.toast.show('Verification email sent successfully.', 'success');
            app.startVerifyPageResendCooldown(60);
        } catch (err) {
            app.state.isResendingVerification = false;
            console.error('[RESEND VERIFICATION ERROR]', err);
            if (btn) btn.innerHTML = originalBtnHtml || 'Resend Verification Email';
            app.toast.show('Network error. Please check your internet connection and try again.', 'error');
            app.startVerifyPageResendCooldown(60);
        }
    },

    startVerifyPageResendCooldown(duration = 60) {
        app.state.verifyPageCooldownSeconds = duration;
        const btn = document.getElementById('btn-verify-resend');
        const textEl = document.getElementById('verify-resend-cooldown');

        // Store target unlock timestamp in localStorage for persistence across reloads
        const unlockTime = Date.now() + (duration * 1000);
        localStorage.setItem('kt_resend_cooldown_until', String(unlockTime));

        if (btn) btn.disabled = true;
        if (textEl) {
            textEl.classList.remove('hidden');
            textEl.innerText = `Resend available in ${app.state.verifyPageCooldownSeconds}s`;
        }

        if (app.state.verifyPageCooldownInterval) clearInterval(app.state.verifyPageCooldownInterval);

        app.state.verifyPageCooldownInterval = setInterval(() => {
            const cooldownUntil = parseInt(localStorage.getItem('kt_resend_cooldown_until') || '0', 10);
            const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));

            app.state.verifyPageCooldownSeconds = remaining;

            if (remaining <= 0) {
                clearInterval(app.state.verifyPageCooldownInterval);
                app.state.verifyPageCooldownInterval = null;
                localStorage.removeItem('kt_resend_cooldown_until');
                const hasEmail = !!(app.state.unverifiedEmail || sessionStorage.getItem('kt_pending_verification_email'));
                if (btn && hasEmail) {
                    btn.disabled = false;
                    btn.innerHTML = 'Resend Verification Email';
                }
                if (textEl) {
                    textEl.classList.add('hidden');
                    textEl.innerText = '';
                }
            } else {
                if (btn) btn.disabled = true;
                if (textEl) {
                    textEl.classList.remove('hidden');
                    textEl.innerText = `Resend available in ${remaining}s`;
                }
            }
        }, 1000);
    },

    // ======================== FORGOT & RESET PASSWORD ========================
    initForgotPasswordView() {
        const formState = document.getElementById('forgot-form-state');
        const sentState = document.getElementById('forgot-sent-state');
        if (formState) formState.classList.remove('hidden');
        if (sentState) sentState.classList.add('hidden');

        // Restore pending reset email if present
        const savedEmail = sessionStorage.getItem('kt_pending_reset_email');
        const emailInput = document.getElementById('forgot-email');
        if (emailInput && savedEmail) emailInput.value = savedEmail;

        // Check for active resend cooldown in localStorage
        const cooldownUntil = parseInt(localStorage.getItem('kt_forgot_resend_cooldown_until') || '0', 10);
        const remainingSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);

        if (remainingSeconds > 0) {
            this.startForgotResendCooldown(remainingSeconds);
        } else {
            localStorage.removeItem('kt_forgot_resend_cooldown_until');
            const btn = document.getElementById('btn-forgot-resend');
            const textEl = document.getElementById('forgot-resend-cooldown');
            if (btn) btn.disabled = false;
            if (textEl) {
                textEl.classList.add('hidden');
                textEl.innerText = '';
            }
        }
    },

    async handleForgotPasswordSubmit(e) {
        if (e) e.preventDefault();

        const emailInput = document.getElementById('forgot-email');
        const email = (emailInput?.value || '').trim();

        if (!email) {
            app.toast.show('Email address is required.', 'error');
            return;
        }

        const emailVal = app.validateEmail(email);
        if (!emailVal.valid) {
            app.toast.show(emailVal.message || 'Please enter a valid email address.', 'error');
            return;
        }

        const btn = document.getElementById('btn-forgot-submit');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-xs"></i> <span>Sending...</span>';
        }

        const redirectUrl = window.location.origin.includes('korantest.my.id')
            ? 'https://www.korantest.my.id/reset-password'
            : `${window.location.origin}/reset-password`;

        try {
            console.log('[FORGOT PASSWORD] Sending reset email to:', email);
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                redirectTo: redirectUrl
            });

            if (error) {
                console.error('[FORGOT PASSWORD ERROR]', error);
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<span>Send Reset Link</span>';
                }
                const msg = error.message ? error.message.toLowerCase() : '';
                if (msg.includes('rate limit') || msg.includes('too many') || error.status === 429) {
                    app.toast.show('Too many requests. Please wait a moment before trying again.', 'warning');
                } else {
                    app.toast.show(error.message || 'Failed to send reset link.', 'error');
                }
                return;
            }

            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span>Send Reset Link</span>';
            }

            sessionStorage.setItem('kt_pending_reset_email', email);

            const formState = document.getElementById('forgot-form-state');
            const sentState = document.getElementById('forgot-sent-state');
            const emailDisplay = document.getElementById('forgot-sent-email-display');

            if (emailDisplay) emailDisplay.innerText = email;
            if (formState) formState.classList.add('hidden');
            if (sentState) sentState.classList.remove('hidden');

            app.toast.show('Password reset link sent! Please check your inbox.', 'success');
            app.startForgotResendCooldown(60);
        } catch (err) {
            console.error('[FORGOT PASSWORD EXCEPTION]', err);
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span>Send Reset Link</span>';
            }
            app.toast.show('Network error. Please try again.', 'error');
        }
    },

    async resendResetEmail() {
        const email = sessionStorage.getItem('kt_pending_reset_email') || document.getElementById('forgot-email')?.value;
        if (!email) {
            app.toast.show('No email address found to resend reset link.', 'error');
            return;
        }

        const cooldownUntil = parseInt(localStorage.getItem('kt_forgot_resend_cooldown_until') || '0', 10);
        const remainingSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
        if (remainingSeconds > 0) {
            app.toast.show(`Please wait ${remainingSeconds} seconds before requesting another email.`, 'warning');
            app.startForgotResendCooldown(remainingSeconds);
            return;
        }

        const btn = document.getElementById('btn-forgot-resend');
        if (btn) btn.disabled = true;

        const redirectUrl = window.location.origin.includes('korantest.my.id')
            ? 'https://www.korantest.my.id/reset-password'
            : `${window.location.origin}/reset-password`;

        try {
            console.log('[RESEND RESET EMAIL] Resending to:', email);
            const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
                redirectTo: redirectUrl
            });

            if (error) {
                console.error('[RESEND RESET ERROR]', error);
                const msg = error.message ? error.message.toLowerCase() : '';
                if (msg.includes('rate limit') || msg.includes('too many') || error.status === 429) {
                    app.toast.show('Too many requests. Please wait a moment before trying again.', 'warning');
                } else {
                    app.toast.show(error.message || 'Failed to resend reset link.', 'error');
                }
                app.startForgotResendCooldown(60);
                return;
            }

            app.toast.show('Password reset link sent! Please check your inbox.', 'success');
            app.startForgotResendCooldown(60);
        } catch (err) {
            console.error('[RESEND RESET EXCEPTION]', err);
            app.toast.show('Network error. Please try again.', 'error');
            app.startForgotResendCooldown(60);
        }
    },

    openResetEmailApp() {
        const email = sessionStorage.getItem('kt_pending_reset_email') || document.getElementById('forgot-email')?.value || '';
        const domain = email.includes('@') ? email.split('@')[1].toLowerCase() : '';

        let webmailUrl = null;
        if (domain === 'gmail.com' || domain === 'googlemail.com') {
            webmailUrl = 'https://mail.google.com';
        } else if (domain === 'yahoo.com' || domain === 'yahoo.co.id' || domain.includes('yahoo')) {
            webmailUrl = 'https://mail.yahoo.com';
        } else if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain === 'msn.com') {
            webmailUrl = 'https://outlook.live.com';
        } else if (domain === 'icloud.com' || domain === 'me.com') {
            webmailUrl = 'https://www.icloud.com/mail';
        } else if (domain === 'proton.me' || domain === 'protonmail.com') {
            webmailUrl = 'https://mail.proton.me';
        }

        if (webmailUrl) {
            window.open(webmailUrl, '_blank');
        } else {
            try {
                window.location.href = 'mailto:';
            } catch (e) {
                console.log('[OPEN RESET EMAIL APP] Fallback failed:', e);
            }
        }
    },

    startForgotResendCooldown(duration = 60) {
        app.state.forgotResendCooldownSeconds = duration;
        const btn = document.getElementById('btn-forgot-resend');
        const textEl = document.getElementById('forgot-resend-cooldown');

        const unlockTime = Date.now() + (duration * 1000);
        localStorage.setItem('kt_forgot_resend_cooldown_until', String(unlockTime));

        if (btn) btn.disabled = true;
        if (textEl) {
            textEl.classList.remove('hidden');
            textEl.innerText = `Resend available in ${duration}s`;
        }

        if (app.state.forgotResendInterval) clearInterval(app.state.forgotResendInterval);

        app.state.forgotResendInterval = setInterval(() => {
            const cooldownUntil = parseInt(localStorage.getItem('kt_forgot_resend_cooldown_until') || '0', 10);
            const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));

            app.state.forgotResendCooldownSeconds = remaining;

            if (remaining <= 0) {
                clearInterval(app.state.forgotResendInterval);
                app.state.forgotResendInterval = null;
                localStorage.removeItem('kt_forgot_resend_cooldown_until');
                if (btn) btn.disabled = false;
                if (textEl) {
                    textEl.classList.add('hidden');
                    textEl.innerText = '';
                }
            } else {
                if (btn) btn.disabled = true;
                if (textEl) {
                    textEl.classList.remove('hidden');
                    textEl.innerText = `Resend available in ${remaining}s`;
                }
            }
        }, 1000);
    },

    async initResetPasswordView() {
        const formState = document.getElementById('reset-form-state');
        const successState = document.getElementById('reset-success-state');
        const invalidState = document.getElementById('reset-invalid-state');

        const showResetState = (targetState) => {
            if (formState) formState.classList.add('hidden');
            if (successState) successState.classList.add('hidden');
            if (invalidState) invalidState.classList.add('hidden');
            if (targetState) targetState.classList.remove('hidden');
        };

        try {
            const { data: { session } } = await supabaseClient.auth.getSession();
            const hash = window.location.hash || window.location.search || '';
            const isRecovery = hash.includes('type=recovery') || hash.includes('access_token=') || app.state.isRecoverySession || !!session;

            if (isRecovery) {
                showResetState(formState);
                this.resetPasswordValidation.init();
            } else {
                showResetState(invalidState);
            }
        } catch (e) {
            console.error('[RESET PASSWORD INIT ERROR]', e);
            showResetState(invalidState);
        }
    },

    async handleResetPasswordSubmit(e) {
        if (e) e.preventDefault();

        const newPwd = document.getElementById('reset-pwd')?.value || '';
        const confirmPwd = document.getElementById('reset-confirm-pwd')?.value || '';
        const errorEl = document.getElementById('reset-confirm-error');

        if (newPwd.length < 8) {
            app.toast.show('Password minimal 8 karakter.', 'error');
            return;
        }

        if (newPwd !== confirmPwd) {
            if (errorEl) errorEl.classList.remove('hidden');
            app.toast.show('Password dan Konfirmasi Password tidak cocok.', 'error');
            return;
        } else {
            if (errorEl) errorEl.classList.add('hidden');
        }

        const btn = document.getElementById('btn-reset-submit');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-xs"></i> <span>Updating Password...</span>';
        }

        try {
            console.log('[RESET PASSWORD] Executing updateUser for new password');
            const { data, error } = await supabaseClient.auth.updateUser({ password: newPwd });

            if (error) {
                console.error('[UPDATE PASSWORD ERROR]', error);
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<span>Update Password</span>';
                }
                const msg = error.message ? error.message.toLowerCase() : '';
                if (msg.includes('same as') || msg.includes('different')) {
                    app.toast.show('Password baru tidak boleh sama dengan password lama.', 'error');
                } else if (msg.includes('weak') || msg.includes('pwned')) {
                    app.toast.show('Password terlalu lemah. Gunakan kombinasi huruf besar, angka, dan simbol.', 'error');
                } else {
                    app.toast.show(error.message || 'Gagal memperbarui password. Silakan coba lagi.', 'error');
                }
                return;
            }

            // Success State
            const formState = document.getElementById('reset-form-state');
            const successState = document.getElementById('reset-success-state');
            if (formState) formState.classList.add('hidden');
            if (successState) successState.classList.remove('hidden');

            // Store user email for autofill on Login
            const userEmail = data?.user?.email;
            if (userEmail) {
                sessionStorage.setItem('kt_post_register_email', userEmail);
                sessionStorage.setItem('kt_verification_just_completed', 'true');
            }

            app.toast.show('Password updated successfully!', 'success');
            app.state.isRecoverySession = false;

            setTimeout(() => {
                if (window.location.pathname.includes('reset-password')) {
                    try {
                        window.history.replaceState(null, '', window.location.origin + '/#login');
                    } catch (err) {
                        console.log('[HISTORY REPLACE ERROR]', err);
                    }
                }
                app.navigate('login', true);
            }, 2000);
        } catch (err) {
            console.error('[UPDATE PASSWORD EXCEPTION]', err);
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span>Update Password</span>';
            }
            app.toast.show('Network error during password reset.', 'error');
        }
    },

    toggleResetPasswordVisibility(inputId, iconId) {
        const input = document.getElementById(inputId);
        const icon = document.getElementById(iconId);
        if (!input || !icon) return;

        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    },

    resetPasswordValidation: {
        init() {
            const pwdInput = document.getElementById('reset-pwd');
            const confirmInput = document.getElementById('reset-confirm-pwd');
            if (pwdInput) {
                pwdInput.addEventListener('input', (e) => this.handlePasswordInput(e.target.value));
            }
            if (confirmInput) {
                confirmInput.addEventListener('input', () => this.checkMatch());
            }
        },
        handlePasswordInput(pwd) {
            const container = document.getElementById('reset-pwd-strength-container');
            const textEl = document.getElementById('reset-pwd-strength-text');
            const bar1 = document.getElementById('reset-pwd-bar-1');
            const bar2 = document.getElementById('reset-pwd-bar-2');
            const bar3 = document.getElementById('reset-pwd-bar-3');

            if (!pwd) {
                if (container) container.classList.add('hidden');
                this.checkMatch();
                return;
            }

            if (container) container.classList.remove('hidden');

            let score = 0;
            if (pwd.length >= 8) score++;
            if (/[a-z]/.test(pwd)) score++;
            if (/[A-Z]/.test(pwd)) score++;
            if (/[0-9]/.test(pwd)) score++;
            if (/[^a-zA-Z0-9]/.test(pwd)) score++;

            if (pwd.length < 8 || score <= 2) {
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-red-400 mt-1';
                    textEl.innerText = 'Password terlalu lemah (minimal 8 karakter).';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-red-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
            } else if (score === 3 || score === 4) {
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-amber-400 mt-1';
                    textEl.innerText = 'Kekuatan password cukup.';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-amber-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-amber-500 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
            } else if (score >= 5) {
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-emerald-400 mt-1';
                    textEl.innerText = 'Password kuat.';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
            }

            this.checkMatch();
        },
        checkMatch() {
            const pwd = document.getElementById('reset-pwd')?.value || '';
            const confirm = document.getElementById('reset-confirm-pwd')?.value || '';
            const errorEl = document.getElementById('reset-confirm-error');

            if (confirm && pwd !== confirm) {
                if (errorEl) errorEl.classList.remove('hidden');
            } else {
                if (errorEl) errorEl.classList.add('hidden');
            }
        }
    },

    // ======================== CHANGE PASSWORD ========================
    openChangePasswordModal() {
        const modal = document.getElementById('modal-change-password');
        if (!modal) return;

        // Secure wipe of input values
        const currInput = document.getElementById('change-curr-pwd');
        const newInput = document.getElementById('change-new-pwd');
        const confirmInput = document.getElementById('change-confirm-pwd');
        if (currInput) currInput.value = '';
        if (newInput) newInput.value = '';
        if (confirmInput) confirmInput.value = '';

        // Reset validation & strength UI
        this.changePasswordValidation.reset();

        modal.classList.remove('hidden');
        if (currInput) setTimeout(() => currInput.focus(), 150);

        // Bind ESC keydown handler
        if (this.state.escChangePasswordHandler) {
            window.removeEventListener('keydown', this.state.escChangePasswordHandler);
        }
        this.state.escChangePasswordHandler = (e) => {
            if (e.key === 'Escape') {
                this.closeChangePasswordModal();
            }
        };
        window.addEventListener('keydown', this.state.escChangePasswordHandler);
    },

    closeChangePasswordModal() {
        const modal = document.getElementById('modal-change-password');
        if (modal) modal.classList.add('hidden');

        // Secure wipe of input values
        const currInput = document.getElementById('change-curr-pwd');
        const newInput = document.getElementById('change-new-pwd');
        const confirmInput = document.getElementById('change-confirm-pwd');
        if (currInput) currInput.value = '';
        if (newInput) newInput.value = '';
        if (confirmInput) confirmInput.value = '';

        this.changePasswordValidation.reset();

        if (this.state.escChangePasswordHandler) {
            window.removeEventListener('keydown', this.state.escChangePasswordHandler);
            this.state.escChangePasswordHandler = null;
        }
    },

    async handleChangePasswordSubmit(e) {
        if (e) e.preventDefault();

        const currPwd = document.getElementById('change-curr-pwd')?.value || '';
        const newPwd = document.getElementById('change-new-pwd')?.value || '';
        const confirmPwd = document.getElementById('change-confirm-pwd')?.value || '';

        const currInput = document.getElementById('change-curr-pwd');
        const newInput = document.getElementById('change-new-pwd');
        const confirmInput = document.getElementById('change-confirm-pwd');

        // Validation 1: Current Password Required
        if (!currPwd) {
            this.toast.show('Current password is required.', 'error');
            if (currInput) currInput.focus();
            return;
        }

        // Validation 2: New Password Required & Length >= 8
        if (!newPwd || newPwd.length < 8) {
            this.toast.show('New password must be at least 8 characters.', 'error');
            if (newInput) newInput.focus();
            return;
        }

        // Validation 3: New Password Different from Current Password
        if (newPwd === currPwd) {
            this.toast.show('New password must be different from current password.', 'error');
            if (newInput) newInput.focus();
            return;
        }

        // Validation 4: Passwords Match
        if (newPwd !== confirmPwd) {
            this.toast.show('Passwords do not match.', 'error');
            const errorEl = document.getElementById('change-confirm-error');
            if (errorEl) errorEl.classList.remove('hidden');
            if (confirmInput) confirmInput.focus();
            return;
        }

        // Prevent duplicate submissions
        if (this.state.isChangingPassword) return;
        this.state.isChangingPassword = true;

        const btn = document.getElementById('btn-change-pwd-submit');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin text-xs"></i> <span>Saving...</span>';
        }

        try {
            const user = this.state.user;
            const email = user?.email;

            if (!email) {
                this.toast.show('Session expired. Please sign in again.', 'error');
                this.state.isChangingPassword = false;
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<span>Save Password</span>';
                }
                this.closeChangePasswordModal();
                this.navigate('login');
                return;
            }

            console.log('[CHANGE PWD] Re-authenticating user:', email);

            // Step 1: Re-authenticate user with Current Password
            const { error: authError } = await supabaseClient.auth.signInWithPassword({
                email: email,
                password: currPwd
            });

            if (authError) {
                console.error('[CHANGE PWD RE-AUTH ERROR]', authError);
                this.state.isChangingPassword = false;
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<span>Save Password</span>';
                }
                this.toast.show('Current password is incorrect.', 'error');
                if (currInput) {
                    currInput.value = '';
                    currInput.focus();
                }
                return;
            }

            console.log('[CHANGE PWD] Re-authentication successful. Updating password...');

            // Step 2: Update password via Supabase Auth API
            const { error: updateError } = await supabaseClient.auth.updateUser({
                password: newPwd
            });

            this.state.isChangingPassword = false;

            if (updateError) {
                console.error('[CHANGE PWD UPDATE ERROR]', updateError);
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<span>Save Password</span>';
                }
                const msg = updateError.message ? updateError.message.toLowerCase() : '';
                if (msg.includes('same as') || msg.includes('different')) {
                    this.toast.show('New password must be different from current password.', 'error');
                    if (newInput) newInput.focus();
                } else if (msg.includes('weak') || msg.includes('pwned')) {
                    this.toast.show('Password too weak. Please use a stronger password.', 'error');
                    if (newInput) newInput.focus();
                } else {
                    this.toast.show(updateError.message || 'Failed to update password. Please try again.', 'error');
                }
                return;
            }

            // Success
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span>Save Password</span>';
            }

            this.toast.show('Password changed successfully.', 'success');
            this.closeChangePasswordModal();
        } catch (err) {
            console.error('[CHANGE PWD EXCEPTION]', err);
            this.state.isChangingPassword = false;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span>Save Password</span>';
            }
            this.toast.show('Network error. Please try again.', 'error');
        }
    },

    toggleChangePasswordVisibility(inputId, iconId) {
        const input = document.getElementById(inputId);
        const icon = document.getElementById(iconId);
        if (!input || !icon) return;

        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    },

    changePasswordValidation: {
        init() {
            const pwdInput = document.getElementById('change-new-pwd');
            const confirmInput = document.getElementById('change-confirm-pwd');
            if (pwdInput) {
                pwdInput.addEventListener('input', (e) => this.handlePasswordInput(e.target.value));
            }
            if (confirmInput) {
                confirmInput.addEventListener('input', () => this.checkMatch());
            }
        },
        handlePasswordInput(pwd) {
            const container = document.getElementById('change-pwd-strength-container');
            const textEl = document.getElementById('change-pwd-strength-text');
            const bar1 = document.getElementById('change-pwd-bar-1');
            const bar2 = document.getElementById('change-pwd-bar-2');
            const bar3 = document.getElementById('change-pwd-bar-3');

            if (!pwd) {
                if (container) container.classList.add('hidden');
                this.checkMatch();
                return;
            }

            if (container) container.classList.remove('hidden');

            let score = 0;
            if (pwd.length >= 8) score++;
            if (/[a-z]/.test(pwd)) score++;
            if (/[A-Z]/.test(pwd)) score++;
            if (/[0-9]/.test(pwd)) score++;
            if (/[^a-zA-Z0-9]/.test(pwd)) score++;

            if (pwd.length < 8 || score <= 2) {
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-red-400 mt-1';
                    textEl.innerText = 'Weak (min. 8 characters)';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-red-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
            } else if (score === 3 || score === 4) {
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-amber-400 mt-1';
                    textEl.innerText = 'Medium';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-amber-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-amber-500 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-slate-700 transition-all duration-300';
            } else if (score >= 5) {
                if (textEl) {
                    textEl.className = 'text-xs font-medium text-emerald-400 mt-1';
                    textEl.innerText = 'Strong';
                }
                if (bar1) bar1.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
                if (bar2) bar2.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
                if (bar3) bar3.className = 'h-full flex-1 bg-emerald-500 transition-all duration-300';
            }

            this.checkMatch();
        },
        checkMatch() {
            const pwd = document.getElementById('change-new-pwd')?.value || '';
            const confirm = document.getElementById('change-confirm-pwd')?.value || '';
            const errorEl = document.getElementById('change-confirm-error');

            if (confirm && pwd !== confirm) {
                if (errorEl) errorEl.classList.remove('hidden');
            } else {
                if (errorEl) errorEl.classList.add('hidden');
            }
        },
        reset() {
            const container = document.getElementById('change-pwd-strength-container');
            const errorEl = document.getElementById('change-confirm-error');
            if (container) container.classList.add('hidden');
            if (errorEl) errorEl.classList.add('hidden');
        }
    },

    // ======================== ACTIONS ========================
    actions: {
        showInfoModal(title, content) {
            const modal = document.getElementById('modal-general-info');
            const titleEl = document.getElementById('info-modal-title');
            const bodyEl = document.getElementById('info-modal-body');
            if (titleEl) titleEl.innerText = title;
            if (bodyEl) bodyEl.innerText = content;
            if (modal) modal.classList.remove('hidden');
        },

        closeInfoModal() {
            const modal = document.getElementById('modal-general-info');
            if (modal) modal.classList.add('hidden');
        },

        loginAsGuest() {
            app.state.user = { name: 'Guest User', email: 'Lokal Browser Cache', isGuest: true };
            localStorage.setItem('kt_user', JSON.stringify(app.state.user));
            app.state.history = JSON.parse(localStorage.getItem('kt_history')) || [];
            app.syncAuthStateDisplay();
            app.toast.show('Berhasil masuk sebagai Guest!', 'success');
            app.navigate('test-menu');
        },

        triggerTestIntent(modeName, durationSeconds) {
            app.state.activeTest = { mode: modeName, duration: durationSeconds };

            if (!app.state.user) {
                document.getElementById('modal-auth-intent').classList.remove('hidden');
            } else {
                this.executeStartTestEngine();
            }
        },

        guestLogin() {
            this.loginAsGuest();
        },

        closeAuthModal() {
            const modal = document.getElementById('modal-auth-intent');
            if (modal) modal.classList.add('hidden');
        },

        continueAsGuest() {
            this.loginAsGuest();
            if (app.state.activeTest) {
                this.executeStartTestEngine();
            }
        },

        modalRoute(route) {
            this.closeAuthModal();
            app.navigate(route);
        },

        modalGuestExecute() {
            this.closeAuthModal();
            this.loginAsGuest();
            this.executeStartTestEngine();
        },

        executeStartTestEngine() {
            const ctx = app.state.activeTest;

            // Reset metrics for 20-second segment tracking
            app.state.metrics = {
                totalAnswered: 0,
                correctAnswers: 0,
                segmentCorrectTracker: 0, // Tracker for correct answers at start of current 20s segment
                seriesScores: []          // Stores correct_answers_in_segment for each 20s interval
            };
            app.state.elapsedSeconds = 0;
            app.state.timeLeft = ctx.duration;

            const titleEl = document.getElementById('active-test-title');
            if (titleEl) titleEl.innerText = ctx.mode;

            // Navigate to test screen
            app.navigate('test-screen');

            // Start engine after view is active
            app.state.isTestRunning = true;
            if (app.achievements) app.achievements.captureBaseline();
            if (app.inactivity) app.inactivity.stopMonitoring();
            this.generateMatrixRow();

            const timerEl = document.getElementById('sim-timer');
            const finishBtn = document.getElementById('btn-finish-test');

            if (ctx.duration > 0) {
                // Timed mode (Quick, Standard, Marathon)
                if (timerEl) { timerEl.classList.remove('hidden'); timerEl.classList.remove('timer-warning'); }
                if (finishBtn) finishBtn.classList.add('hidden');
                this.runTimerLoop();
            } else {
                // Free Practice / Untimed mode — show finish button, hide timer
                if (timerEl) timerEl.classList.add('hidden');
                if (finishBtn) finishBtn.classList.remove('hidden');
                this.runTimerLoop();
            }
        },

        generateMatrixRow() {
            const t = Math.floor(Math.random() * 9) + 1;
            const b = Math.floor(Math.random() * 9) + 1;
            app.state.currentSumTarget = (t + b) % 10;

            const topEl = document.getElementById('digit-top');
            const botEl = document.getElementById('digit-bottom');
            const inputEl = document.getElementById('input-placeholder');
            if (topEl) topEl.innerText = t;
            if (botEl) botEl.innerText = b;
            if (inputEl) inputEl.innerText = '?';
        },

        inputDigit(digit) {
            if (!app.state.isTestRunning) return;

            const inputEl = document.getElementById('input-placeholder');
            if (inputEl) inputEl.innerText = digit;

            app.state.metrics.totalAnswered++;

            // Raw Score: Only correct answers add 1 point (+1 correct, +0 wrong/unanswered)
            if (digit === app.state.currentSumTarget) {
                app.state.metrics.correctAnswers++;
            }

            // Synchronously update row for next target so rapid typing is scored with 100% accuracy
            this.generateMatrixRow();
        },

        runTimerLoop() {
            if (app.state.timer) clearInterval(app.state.timer);
            this.refreshTimerUI();

            app.state.timer = setInterval(() => {
                if (app.state.activeTest.duration > 0) {
                    app.state.timeLeft--;
                    app.state.elapsedSeconds++;
                } else {
                    // Free Practice mode (counts up elapsed time)
                    app.state.elapsedSeconds++;
                }

                this.refreshTimerUI();

                // 20-SECOND SEGMENT TRACKING ENGINE:
                // Every 20 seconds of test duration, record correct_answers_in_segment
                if (app.state.elapsedSeconds > 0 && app.state.elapsedSeconds % 20 === 0) {
                    const currentTotalCorrect = app.state.metrics.correctAnswers;
                    const segmentCorrect = currentTotalCorrect - app.state.metrics.segmentCorrectTracker;
                    app.state.metrics.seriesScores.push(segmentCorrect);
                    app.state.metrics.segmentCorrectTracker = currentTotalCorrect;
                }

                // Warning state when <= 30 seconds
                if (app.state.activeTest.duration > 0 && app.state.timeLeft <= 30 && app.state.timeLeft > 0) {
                    const timerEl = document.getElementById('sim-timer');
                    if (timerEl) timerEl.classList.add('timer-warning');
                }

                if (app.state.activeTest.duration > 0 && app.state.timeLeft <= 0) {
                    this.finalizeTestResults();
                }
            }, 1000);
        },

        refreshTimerUI() {
            const timeVal = app.state.activeTest.duration > 0 ? app.state.timeLeft : app.state.elapsedSeconds;
            const m = Math.floor(timeVal / 60).toString().padStart(2, '0');
            const s = (timeVal % 60).toString().padStart(2, '0');
            const timerEl = document.getElementById('sim-timer');
            if (timerEl) timerEl.innerText = `${m}:${s}`;
        },

        async finalizeTestResults() {
            this.terminateTestEngine();

            // Flush final 20s segment if test ends with remaining seconds
            const remainingSeconds = app.state.elapsedSeconds % 20;
            if (remainingSeconds >= 5 || app.state.metrics.seriesScores.length === 0) {
                const currentTotalCorrect = app.state.metrics.correctAnswers;
                const segmentCorrect = currentTotalCorrect - app.state.metrics.segmentCorrectTracker;
                app.state.metrics.seriesScores.push(segmentCorrect);
            }

            const m = app.state.metrics;

            // 1. WRONG ANSWER PENALTY & RAW SCORE CALCULATION
            // Correct: +1, Wrong: -0.25, Unanswered: 0
            // Formula: raw_score = Math.max(0, correct_answers - (wrong_answers * 0.25))
            const totalCorrect = m.correctAnswers;
            const totalWrong = Math.max(0, m.totalAnswered - m.correctAnswers);
            const rawScore = Math.max(0, Number((totalCorrect - (totalWrong * 0.25)).toFixed(2)));

            // 2. ACCURACY CALCULATION ((total_correct / total_answered) * 100, clamped 0-100)
            const accuracy = m.totalAnswered > 0 ? Math.max(0, Math.min(100, Math.round((totalCorrect / m.totalAnswered) * 100))) : 0;

            // 3. CONSISTENCY CALCULATION (0-100 score based on 20s segment std dev)
            const consistency = app.calculateConsistency(m.seriesScores);

            // 4. FINAL SCORE FORMULA
            // Formula: Final Score = Math.round((raw_score * 0.75) + (consistency * 0.15) + (accuracy * 0.10))
            const finalScore = Math.round(
                (rawScore * 0.75) +
                (consistency * 0.15) +
                (accuracy * 0.10)
            );

            // 5. SEGMENT DATA STORAGE (20-second segment performance array)
            const segmentData = [...m.seriesScores];

            const modeName = app.state.activeTest?.mode || 'Quick Test';
            const isFreePractice = modeName === 'Latihan Bebas' || app.state.activeTest?.duration === 0;

            // Update Result UI elements
            const el = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };
            el('stat-res-correct', totalCorrect);
            el('stat-res-wrong', totalWrong);
            el('stat-res-acc', `${accuracy}%`);
            el('stat-res-cons', consistency);
            el('stat-res-rawscore', rawScore.toFixed(2));
            el('stat-res-score', finalScore);

            const scoreContainer = document.getElementById('result-score-container');
            const badgeEl = document.getElementById('stat-res-badge');

            if (isFreePractice) {
                // Free Practice Rules: Display performance stats, do NOT display score, rank, or leaderboard status
                if (scoreContainer) scoreContainer.classList.add('hidden');
            } else {
                if (scoreContainer) scoreContainer.classList.remove('hidden');
                if (badgeEl) badgeEl.innerText = modeName;
            }

            let advice = 'Fokus Anda memadai untuk pemanasan reguler. ';
            if (accuracy < 85) advice += 'Tingkatkan ketelitian hitung dasar dengan berlatih di Mode Bebas.';
            else advice += 'Pertahankan stabilitas motorik Anda untuk tes rekrutmen utama.';
            el('stat-res-advice', advice);

            app.syncAuthStateDisplay();
            app.navigate('result');

            // Free Practice Rules: Do NOT save to test_results, do NOT save to history, do NOT affect leaderboard
            if (isFreePractice) {
                app.toast.show(`Praktek selesai! Benar: ${totalCorrect}, Akurasi: ${accuracy}%, Konsistensi: ${consistency}`, 'info');
                return;
            }

            const d = new Date();
            const formattedDate = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;

            const item = {
                date: formattedDate,
                mode: modeName,
                totalAnswered: m.totalAnswered,
                correctAnswers: totalCorrect,
                wrongAnswers: totalWrong,
                rawScore: rawScore,
                score: finalScore,
                accuracy: accuracy,
                consistency: consistency,
                segmentData: segmentData,
                duration: app.state.activeTest?.duration || 60
            };

            // Save scored test modes (Quick, Standard, Marathon) to Supabase test_results
            if (app.state.user && !app.state.user.isGuest) {
                try {
                    const { error } = await supabaseClient
                        .from('test_results')
                        .insert({
                            user_id: app.state.user.id,
                            mode: item.mode,
                            score: finalScore,
                            raw_score: rawScore,
                            total_answered: m.totalAnswered,
                            correct_answers: totalCorrect,
                            wrong_answers: totalWrong,
                            accuracy: accuracy,
                            consistency: consistency,
                            segment_data: segmentData,
                            duration: item.duration
                        });

                    if (error) {
                        console.error('Gagal menyimpan hasil tes ke Supabase:', error);
                    }
                    await app.loadHistory();

                    // Standard Test Cached Leaderboard Update
                    if (item.mode === 'Standard' || item.mode === 'Standard Test') {
                        const { data: profileData, error: profileErr } = await supabaseClient
                            .from('profiles')
                            .select('best_standard_score, best_standard_accuracy, best_standard_consistency, best_standard_test_date')
                            .eq('id', app.state.user.id)
                            .maybeSingle();

                        if (!profileErr) {
                            const currentScore = profileData?.best_standard_score || 0;
                            const currentAcc = profileData?.best_standard_accuracy || 0;
                            const currentCons = profileData?.best_standard_consistency || 0;
                            const currentDate = profileData?.best_standard_test_date ? new Date(profileData.best_standard_test_date).getTime() : Infinity;

                            const newScore = finalScore;
                            const newAcc = accuracy;
                            const newCons = consistency;
                            const nowIso = new Date().toISOString();
                            const newDate = new Date(nowIso).getTime();

                            let isBetter = false;
                            if (newScore > currentScore) {
                                isBetter = true;
                            } else if (newScore === currentScore) {
                                if (newAcc > currentAcc) {
                                    isBetter = true;
                                } else if (newAcc === currentAcc) {
                                    if (newCons > currentCons) {
                                        isBetter = true;
                                    } else if (newCons === currentCons) {
                                        if (newDate < currentDate) {
                                            isBetter = true;
                                        }
                                    }
                                }
                            }

                            if (isBetter) {
                                const { error: updateErr } = await supabaseClient
                                    .from('profiles')
                                    .update({
                                        best_standard_score: newScore,
                                        best_standard_accuracy: newAcc,
                                        best_standard_consistency: newCons,
                                        best_standard_test_date: nowIso
                                    })
                                    .eq('id', app.state.user.id);

                                if (!updateErr) {
                                    app.state.user.best_standard_score = newScore;
                                    app.state.user.best_standard_accuracy = newAcc;
                                    app.state.user.best_standard_consistency = newCons;
                                    app.state.user.best_standard_test_date = nowIso;
                                    localStorage.setItem('kt_user', JSON.stringify(app.state.user));

                                    console.log('[BEST SCORE UPDATED]', {
                                        best_standard_score: newScore,
                                        best_standard_accuracy: newAcc,
                                        best_standard_consistency: newCons,
                                        best_standard_test_date: nowIso
                                    });
                                }
                            } else {
                                 console.log('[BEST SCORE UNCHANGED]');
                            }
                        }
                    }

                    // Force refresh single source of truth Leaderboard data
                    await app.getLeaderboardData('alltime', true);
                    await app.getLeaderboardData('weekly', true);
                    if (app.state.currentView === 'leaderboard' && app.leaderboard) {
                        await app.leaderboard.render();
                    }
                } catch (err) {
                    console.error('Error insert test result / update cache:', err);
                }
            } else {
                // Guest mode for scored test: Save to localStorage history
                app.state.history.push(item);
                localStorage.setItem('kt_history', JSON.stringify(app.state.history));
            }

            app.state.isTestRunning = false;
            if (app.inactivity) app.inactivity.startMonitoring();
            app.toast.show(`Test completed! Final Score: ${finalScore} | Raw: ${rawScore} | Accuracy: ${accuracy}%`, 'success');

            // Trigger Achievement Unlock Check
            if (app.achievements) {
                app.achievements.checkUnlocksAfterTest();
            }
        },

        terminateTestEngine() {
            app.state.isTestRunning = false;
            if (app.state.timer) clearInterval(app.state.timer);
            if (app.inactivity) app.inactivity.startMonitoring();
        },

        async handleAuth(event, type) {
    event.preventDefault();

    try {

        // =====================
        // REGISTER
        // =====================
        if (type === 'register') {
            const rawUsername = document.getElementById('reg-name').value;
            const email = document.getElementById('reg-email').value.trim();
            const password = document.getElementById('reg-pwd').value;

            // Username validation
            const uValidation = app.validateUsername(rawUsername);
            if (!uValidation.valid) {
                app.toast.show(uValidation.message, 'error');
                return;
            }

            if (!app.usernameValidation.isAvailable) {
                app.toast.show('Username is not available or still being checked.', 'error');
                return;
            }

            const username = uValidation.value;

            // Set registration flag BEFORE signUp to prevent onAuthStateChange from firing processSessionUser
            app.state.isRegistering = true;

            // Disable register button and show loading state
            const registerBtn = document.getElementById('btn-register-submit');
            const originalBtnText = registerBtn ? registerBtn.innerText : 'Register Now';
            if (registerBtn) {
                registerBtn.disabled = true;
                registerBtn.innerText = 'Creating Account...';
            }

            try {
                console.log('[REGISTER] Starting registration for:', email);

                const verifyRedirectUrl = window.location.origin.includes('korantest.my.id') 
                    ? 'https://www.korantest.my.id/verify-email' 
                    : `${window.location.origin}/verify-email`;

                const { data, error } = await supabaseClient.auth.signUp({
                    email,
                    password,
                    options: {
                        data: { username: username },
                        emailRedirectTo: verifyRedirectUrl
                    }
                });

                if (error) {
                    app.toast.show(error.message, 'error');
                    app.state.isRegistering = false;
                    if (registerBtn) {
                        registerBtn.disabled = false;
                        registerBtn.innerText = originalBtnText;
                    }
                    return;
                }

                console.log('[REGISTER] Registration successful');

                // Create profile in profiles table
                if (data.user) {
                    try {
                        console.log('[PROFILE] Creating profile:', {
                            id: data.user.id,
                            username: username,
                            display_name: null,
                            email: data.user.email
                        });

                        const { error: profileError } = await supabaseClient
                            .from('profiles')
                            .upsert({
                                id: data.user.id,
                                username: username,
                                display_name: null,
                                email: data.user.email
                            }, { onConflict: 'id' });

                        if (profileError) {
                            console.warn('[PROFILE] Client-side profile insert rejected (RLS/unauthenticated):', profileError);
                        } else {
                            console.log('[PROFILE] Profile created');
                        }

                        // Verify profile was created by fetching it
                        const { data: verifyProfile } = await supabaseClient
                            .from('profiles')
                            .select('id, username')
                            .eq('id', data.user.id)
                            .maybeSingle();

                        if (verifyProfile) {
                            console.log('[PROFILE] Profile fetched');
                            console.log('[PROFILE] Username:', verifyProfile.username);
                        } else {
                            console.log('[PROFILE] Profile not found after creation (may be created by DB trigger)');
                        }
                    } catch (err) {
                        console.error('[PROFILE] Error creating profile:', err);
                    }
                }

                // Sign out to prevent onAuthStateChange from processing the session
                try {
                    await supabaseClient.auth.signOut();
                } catch (signOutErr) {
                    console.warn('[REGISTER] Sign out after registration failed:', signOutErr);
                }

                // Clear registration flag
                app.state.isRegistering = false;
                app.state.user = null;

                // Show success button state
                if (registerBtn) {
                    registerBtn.innerText = '✓ Registration Successful';
                }

                app.state.unverifiedEmail = email;
                app.state.pendingRegistrationUsername = username;
                sessionStorage.setItem('kt_pending_verification_email', email);
                sessionStorage.setItem('kt_pending_registration_username', username);

                app.toast.show('Verification email sent! Please check your inbox.', 'success');

                // Redirect to Verify Email Waiting Room
                setTimeout(() => {
                    console.log('[NAVIGATION] Verify Email Waiting Room');
                    app.navigate('verify-email');

                    // Reset register button for next time
                    if (registerBtn) {
                        registerBtn.disabled = false;
                        registerBtn.innerText = originalBtnText;
                    }
                    app.resetAuthForms('register');
                }, 600);

            } catch (err) {
                console.error('[REGISTER] Error:', err);
                app.toast.show('An error occurred during registration.', 'error');
                app.state.isRegistering = false;
                if (registerBtn) {
                    registerBtn.disabled = false;
                    registerBtn.innerText = originalBtnText;
                }
            }

            return;
        }

        // =====================
        // LOGIN
        // =====================

        const email =
            document.getElementById('login-email').value.trim();

        const password =
            document.getElementById('login-pwd').value;

        const { data, error } =
            await supabaseClient.auth.signInWithPassword({
                email,
                password
            });

        if (error) {
            console.error(error);
            const errLower = (error.message || '').toLowerCase();
            const isUnverifiedErr = errLower.includes('email not confirmed') ||
                                    errLower.includes('email_not_confirmed') ||
                                    errLower.includes('unverified');

            if (isUnverifiedErr) {
                app.state.unverifiedEmail = email;
                const banner = document.getElementById('unverified-email-banner');
                const msgEl = document.getElementById('unverified-banner-msg');
                if (banner) banner.classList.remove('hidden');
                if (msgEl) msgEl.innerText = 'Your email address has not been verified yet. Please check your inbox and click the verification link before signing in.';

                app.toast.show(
                    'Your email address has not been verified yet. Please check your inbox and click the verification link before signing in.',
                    'error'
                );
            } else if (errLower.includes('invalid login credentials')) {
                app.toast.show(
                    'Email atau password salah',
                    'error'
                );
            } else {
                app.toast.show(
                    error.message,
                    'error'
                );
            }
            return;
        }

        // Check if email is confirmed in user object
        const isEmailConfirmed = data.user ? !!(data.user.email_confirmed_at || data.user.confirmed_at) : false;

        if (data.user && !isEmailConfirmed) {
            console.log('[AUTH] Login prevented — Email unverified for:', email);
            await supabaseClient.auth.signOut();
            app.state.unverifiedEmail = email;

            const banner = document.getElementById('unverified-email-banner');
            const msgEl = document.getElementById('unverified-banner-msg');
            if (banner) banner.classList.remove('hidden');
            if (msgEl) msgEl.innerText = 'Your email address has not been verified yet. Please check your inbox and click the verification link before signing in.';

            app.toast.show(
                'Your email address has not been verified yet. Please check your inbox and click the verification link before signing in.',
                'error'
            );
            return;
        }

        // Hide unverified banner on successful verified login
        const unverifiedBanner = document.getElementById('unverified-email-banner');
        if (unverifiedBanner) unverifiedBanner.classList.add('hidden');
        app.state.unverifiedEmail = null;

        // Auto-create profile jika belum ada di tabel profiles
        try {
            const { data: existingProfile } = await supabaseClient
                .from('profiles')
                .select('id')
                .eq('id', data.user.id)
                .maybeSingle();

            if (!existingProfile) {
                // Ambil username dari user_metadata (yang disimpan saat register) atau fallback
                const metaUsername = data.user.user_metadata?.username;
                const fallbackUsername = data.user.email.split('@')[0].trim().toLowerCase().replace(/[^a-z0-9_]/g, '') || ('user_' + Date.now());
                const username = metaUsername || fallbackUsername;

                console.log('[DEBUG Login] Profile belum ada. Membuat profile dengan username:', username);

                const { error: insertErr } = await supabaseClient
                    .from('profiles')
                    .insert({
                        id: data.user.id,
                        username: username,
                        display_name: null,
                        email: data.user.email
                    });

                if (insertErr) {
                    console.error('[DEBUG Login] Gagal auto-create profile:', insertErr);
                } else {
                    console.log('[DEBUG Login] Profile berhasil dibuat otomatis saat login.');
                }
            }
        } catch (profileErr) {
            console.error('[DEBUG Login] Error checking/creating profile:', profileErr);
        }

        // Load profile dari tabel profiles
        app.state.user = await app.fetchUserProfile(data.user.id, data.user.email);

        localStorage.setItem(
            'kt_user',
            JSON.stringify(app.state.user)
        );

        console.log('[AUTH] Fresh Login');
        app.toast.show(
            'Login successful!',
            'success'
        );

        app.resetAuthForms('all');
        app.syncAuthStateDisplay();
        app.navigate('dashboard');

    } 
    
    catch (err) {
        console.error(err);

        app.toast.show(
            'Terjadi kesalahan saat autentikasi.',
            'error'
        );
    }
},

        async googleLogin() {
            console.log('[GOOGLE LOGIN]');
            sessionStorage.setItem('kt_google_login_pending', 'true');
            const btn = document.getElementById('btn-google-login');
            const icon = document.getElementById('btn-google-icon');
            const spinner = document.getElementById('btn-google-spinner');
            const text = document.getElementById('btn-google-text');

            if (btn && btn.disabled) return;

            if (btn) btn.disabled = true;
            if (icon) icon.classList.add('hidden');
            if (spinner) spinner.classList.remove('hidden');
            if (text) text.innerText = 'Connecting...';

            try {
                const { data, error } = await supabaseClient.auth.signInWithOAuth({
                    provider: 'google',
                    options: {
                        redirectTo: window.location.origin + window.location.pathname
                    }
                });

                if (error) {
                    console.log('[GOOGLE LOGIN FAILED]', error);
                    app.toast.show('Google login failed: ' + error.message, 'error');
                    this.resetGoogleLoginButton();
                }
            } catch (err) {
                console.log('[GOOGLE LOGIN FAILED]', err);
                app.toast.show('Google login failed: ' + (err.message || err), 'error');
                this.resetGoogleLoginButton();
            }
        },

        async resendVerificationEmail() {
            const emailInput = document.getElementById('login-email');
            const email = (emailInput?.value || app.state.unverifiedEmail || '').trim();

            if (!email) {
                app.toast.show('Please enter your email address.', 'error');
                return;
            }

            const btn = document.getElementById('btn-resend-verification');
            if (btn && btn.disabled) return;

            if (btn) btn.disabled = true;

            try {
                console.log('[RESEND VERIFICATION] Sending to:', email);
                const { error } = await supabaseClient.auth.resend({
                    type: 'signup',
                    email: email
                });

                if (error) {
                    console.error('[RESEND VERIFICATION FAILED]', error);
                    app.toast.show(error.message, 'error');
                    if (app.state.resendCooldownSeconds <= 0 && btn) btn.disabled = false;
                    return;
                }

                app.toast.show('Verification email sent! Please check your inbox.', 'success');
                this.startResendCooldown(60);
            } catch (err) {
                console.error('[RESEND VERIFICATION ERROR]', err);
                app.toast.show('Failed to send verification email.', 'error');
                if (app.state.resendCooldownSeconds <= 0 && btn) btn.disabled = false;
            }
        },

        startVerifyPageResendCooldown(duration = 60) { app.startVerifyPageResendCooldown(duration); },
        initVerifyEmailView() { app.initVerifyEmailView(); },
        startEmailVerificationPolling() { app.startEmailVerificationPolling(); },
        stopEmailVerificationPolling() { app.stopEmailVerificationPolling(); },
        handleVerificationSuccess(verifiedEmail) { app.handleVerificationSuccess(verifiedEmail); },
        openEmailApp() { app.openEmailApp(); },
        changeEmailFromVerify() { app.changeEmailFromVerify(); },
        startVerifyPageResendCooldown(duration = 60) { app.startVerifyPageResendCooldown(duration); },
        initVerifyEmailView() { app.initVerifyEmailView(); },
        startEmailVerificationPolling() { app.startEmailVerificationPolling(); },
        stopEmailVerificationPolling() { app.stopEmailVerificationPolling(); },
        handleVerificationSuccess(verifiedEmail) { app.handleVerificationSuccess(verifiedEmail); },
        openEmailApp() { app.openEmailApp(); },
        changeEmailFromVerify() { app.changeEmailFromVerify(); },
        resendVerificationFromPage() { app.resendVerificationFromPage(); },
        handleForgotPasswordSubmit(e) { app.handleForgotPasswordSubmit(e); },
        resendResetEmail() { app.resendResetEmail(); },
        openResetEmailApp() { app.openResetEmailApp(); },
        handleResetPasswordSubmit(e) { app.handleResetPasswordSubmit(e); },
        toggleResetPasswordVisibility(inputId, iconId) { app.toggleResetPasswordVisibility(inputId, iconId); },
        openChangePasswordModal() { app.openChangePasswordModal(); },
        closeChangePasswordModal() { app.closeChangePasswordModal(); },
        handleChangePasswordSubmit(e) { app.handleChangePasswordSubmit(e); },
        toggleChangePasswordVisibility(inputId, iconId) { app.toggleChangePasswordVisibility(inputId, iconId); },

        startResendCooldown(duration = 60) {
            app.state.resendCooldownSeconds = duration;
            const btn = document.getElementById('btn-resend-verification');
            const textEl = document.getElementById('resend-cooldown-text');

            if (btn) btn.disabled = true;
            if (textEl) {
                textEl.classList.remove('hidden');
                textEl.innerText = `Resend available in ${app.state.resendCooldownSeconds}s`;
            }

            if (app.state.resendInterval) clearInterval(app.state.resendInterval);

            app.state.resendInterval = setInterval(() => {
                app.state.resendCooldownSeconds--;
                if (app.state.resendCooldownSeconds <= 0) {
                    clearInterval(app.state.resendInterval);
                    app.state.resendInterval = null;
                    if (btn) btn.disabled = false;
                    if (textEl) {
                        textEl.classList.add('hidden');
                        textEl.innerText = '';
                    }
                } else {
                    if (textEl) textEl.innerText = `Resend available in ${app.state.resendCooldownSeconds}s`;
                }
            }, 1000);
        },

        resetGoogleLoginButton() {
            sessionStorage.removeItem('kt_google_login_pending');
            const btn = document.getElementById('btn-google-login');
            const icon = document.getElementById('btn-google-icon');
            const spinner = document.getElementById('btn-google-spinner');
            const text = document.getElementById('btn-google-text');

            if (btn) btn.disabled = false;
            if (icon) icon.classList.remove('hidden');
            if (spinner) spinner.classList.add('hidden');
            if (text) text.innerText = 'Continue with Google';
        },

        async completeGoogleRegistration(event) {
            event.preventDefault();

            if (!app.state.pendingGoogleAuth) {
                app.toast.show('Authentication session not found. Please sign in again.', 'error');
                app.navigate('login');
                return;
            }

            const usernameInput = document.getElementById('onboarding-username')?.value;
            const uValidation = app.validateUsername(usernameInput);
            if (!uValidation.valid) {
                app.toast.show(uValidation.message, 'error');
                return;
            }

            if (!app.onboardingUsernameValidation.isAvailable) {
                app.toast.show('Username is not valid or unavailable.', 'error');
                return;
            }

            const cleanUsername = uValidation.value;
            const pendingAuth = app.state.pendingGoogleAuth;

            const nowIso = new Date().toISOString();
            const newProfile = {
                id: pendingAuth.id,
                email: pendingAuth.email,
                username: cleanUsername,
                display_name: null,
                avatar_url: null,
                role: 'user',
                created_at: nowIso,
                updated_at: nowIso
            };

            try {
                const { error } = await supabaseClient
                    .from('profiles')
                    .insert(newProfile);

                if (error) {
                    console.log('[GOOGLE LOGIN FAILED]', error);
                    if (error.code === '23505') {
                        app.toast.show('Username or Email is already registered with another account.', 'error');
                    } else {
                        app.toast.show('Failed to create profile: ' + error.message, 'error');
                    }
                    return;
                }

                console.log('[GOOGLE PROFILE CREATED]', newProfile);
                app.state.pendingGoogleAuth = null;
                app.state.user = {
                    id: newProfile.id,
                    username: newProfile.username,
                    displayName: null,
                    name: newProfile.username,
                    email: newProfile.email,
                    bio: null,
                    avatarUrl: null,
                    avatar_url: null,
                    usernameLastChanged: null,
                    isGuest: false
                };
                localStorage.setItem('kt_user', JSON.stringify(app.state.user));

                console.log('[AUTH] Fresh Login');
                console.log('[GOOGLE LOGIN SUCCESS]');
                app.toast.show('Registration successful! Welcome.', 'success');
                app.syncAuthStateDisplay();
                app.navigate('dashboard');
            } catch (err) {
                console.log('[GOOGLE LOGIN FAILED]', err);
                app.toast.show('An error occurred during registration.', 'error');
            }
        },

        async logout() {
            if (app.inactivity) app.inactivity.stopMonitoring();
            try {
                await supabaseClient.auth.signOut();
            } catch (err) {
                console.error("Error signing out:", err);
            }

            app.state.user = null;
            app.state.pendingGoogleAuth = null;
            app.state.history = [];
            localStorage.removeItem('kt_user');
            localStorage.removeItem('kt_history');
            app.resetAuthForms('all');
            app.syncAuthStateDisplay();
            app.toast.show('Successfully logged out', 'success');
            app.navigate('home');
        },

        dismissAnnouncement() {
            const banner = document.getElementById('announcement-banner');
            if (banner) banner.classList.add('hidden');
            app.state.announcementDismissed = true;
            localStorage.setItem('kt_announcement_dismissed', 'true');
        },

        async saveProfile() {
            const user = app.state.user;
            if (!user) return;

            const rawUsername = document.getElementById('edit-username')?.value;
            const rawDisplayName = document.getElementById('edit-displayname')?.value;
            const rawBio = document.getElementById('edit-bio')?.value;

            // Validate Username
            const uValidation = app.validateUsername(rawUsername);
            if (!uValidation.valid) {
                app.toast.show(uValidation.message, 'error');
                return;
            }
            const newUsername = uValidation.value;

            // Validate Display Name
            const dValidation = app.validateDisplayName(rawDisplayName);
            if (!dValidation.valid) {
                app.toast.show(dValidation.message, 'error');
                return;
            }
            const newDisplayName = dValidation.value;

            // Validate Bio
            const bValidation = app.validateBio(rawBio);
            if (!bValidation.valid) {
                app.toast.show(bValidation.message, 'error');
                return;
            }
            const newBio = bValidation.value;

            // Check 7-day rate limit if username changed
            const isUsernameChanged = user.username && newUsername !== user.username;
            if (isUsernameChanged && user.usernameLastChanged) {
                const lastChanged = new Date(user.usernameLastChanged).getTime();
                const diffDays = (Date.now() - lastChanged) / (1000 * 60 * 60 * 24);
                if (diffDays < 7) {
                    const daysLeft = Math.ceil(7 - diffDays);
                    app.toast.show(`Username can only be changed once every 7 days. Try again in ${daysLeft} day(s).`, 'warning');
                    return;
                }
            }

            if (!user.isGuest) {
                try {
                    const updatePayload = {
                        username: newUsername,
                        display_name: newDisplayName,
                        bio: newBio
                    };
                    if (isUsernameChanged) {
                        const nowIso = new Date().toISOString();
                        updatePayload.username_changed_at = nowIso;
                    }

                    const { error } = await supabaseClient
                        .from('profiles')
                        .update(updatePayload)
                        .eq('id', user.id);

                    if (error) {
                        console.error('Gagal memperbarui profil ke Supabase:', error);
                        if (error.code === '23505') {
                            app.toast.show('Username is already used by another account.', 'error');
                        } else {
                            app.toast.show('Failed to update profile: ' + error.message, 'error');
                        }
                        return;
                    }

                    if (isUsernameChanged) {
                        user.usernameLastChanged = updatePayload.username_changed_at;
                    }
                } catch (err) {
                    console.error('Error saveProfile:', err);
                    app.toast.show('An error occurred while saving profile.', 'error');
                    return;
                }
            }

            user.username = newUsername;
            user.displayName = newDisplayName;
            user.bio = newBio;
            user.name = newDisplayName || newUsername;

            const avatarUrl = user.avatarUrl || user.avatar_url || null;
            user.avatarUrl = avatarUrl;
            user.avatar_url = avatarUrl;

            app.state.user = user;
            localStorage.setItem('kt_user', JSON.stringify(user));

            app.syncAuthStateDisplay();
            app.renderAvatar('profile-avatar', user);
            app.renderAvatar('usr-avatar', user);
            app.renderAvatar('edit-avatar-preview', user);

            console.log('[PROFILE SAVE SUCCESS]');
            console.log('[AVATAR URL]', avatarUrl);
            console.log('[STATE USER]', app.state.user);

            app.toast.show('Profile updated successfully!', 'success');
            app.navigate('profile');
        },

        async handleAvatarSelect(event) {
            const file = event.target.files?.[0];
            if (!file) return;

            const user = app.state.user;
            if (!user || user.isGuest) {
                app.toast.show('Only registered users can upload a profile photo.', 'warning');
                return;
            }

            const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
            const fileExt = file.name.split('.').pop().toLowerCase();
            const validExts = ['jpg', 'jpeg', 'png', 'webp'];

            if (!validTypes.includes(file.type) && !validExts.includes(fileExt)) {
                app.toast.show('File format must be JPG, JPEG, PNG, or WEBP.', 'error');
                return;
            }

            if (file.size > 10 * 1024 * 1024) {
                app.toast.show('Original file size cannot exceed 10MB.', 'error');
                return;
            }

            try {
                app.toast.show('Converting and uploading profile photo...', 'info');

                // 1. Convert image to JPG (90% quality) using Canvas API while preserving aspect ratio
                const jpgBlob = await app.convertImageToJpgBlob(file, 0.90);

                // Live preview using converted JPG Blob
                const previewEl = document.getElementById('edit-avatar-preview');
                if (previewEl) {
                    const previewUrl = URL.createObjectURL(jpgBlob);
                    previewEl.innerHTML = `<img src="${previewUrl}" class="w-full h-full object-cover rounded-full">`;
                }

                // 2. Storage file naming: <user_id>.jpg (e.g. 0649ee9a-916c-4f57-a72c-2c1be4097756.jpg)
                const storageFilePath = `${user.id}.jpg`;

                // 3. Upload using upsert: true so it replaces previous file (only 1 file per user)
                const { error: uploadError } = await supabaseClient.storage
                    .from('avatars')
                    .upload(storageFilePath, jpgBlob, {
                        contentType: 'image/jpeg',
                        cacheControl: '3600',
                        upsert: true
                    });

                if (uploadError) {
                    console.error('Error uploading avatar to Storage:', uploadError);
                    app.toast.show('Failed to upload photo: ' + uploadError.message, 'error');
                    app.renderAvatar('edit-avatar-preview', user);
                    return;
                }

                // 4. Get public URL
                const { data: urlData } = supabaseClient.storage
                    .from('avatars')
                    .getPublicUrl(storageFilePath);

                const publicUrl = urlData?.publicUrl;

                if (!publicUrl) {
                    app.toast.show('Failed to obtain photo URL.', 'error');
                    return;
                }

                // Cache buster timestamp parameter to force browser refresh on same-filename update
                const avatarUrlWithCacheBuster = `${publicUrl}?v=${Date.now()}`;

                // 5. Store URL in profiles.avatar_url
                const { error: dbError } = await supabaseClient
                    .from('profiles')
                    .update({ avatar_url: avatarUrlWithCacheBuster })
                    .eq('id', user.id);

                if (dbError) {
                    console.error('Error updating profiles.avatar_url:', dbError);
                    app.toast.show('Failed to save profile photo to database.', 'error');
                    return;
                }

                // Update state & localStorage
                user.avatarUrl = avatarUrlWithCacheBuster;
                user.avatar_url = avatarUrlWithCacheBuster;
                app.state.user = user;
                localStorage.setItem('kt_user', JSON.stringify(user));

                // Sync UI everywhere
                app.syncAuthStateDisplay();
                app.renderAvatar('profile-avatar', user);
                app.renderAvatar('usr-avatar', user);
                app.renderAvatar('edit-avatar-preview', user);

                const removeBtn = document.getElementById('btn-remove-avatar');
                if (removeBtn) removeBtn.classList.remove('hidden');

                console.log('[AVATAR UPDATE SUCCESS]');
                console.log('[AVATAR URL]', avatarUrlWithCacheBuster);
                console.log('[STATE USER]', app.state.user);

                app.toast.show('Profile photo updated successfully!', 'success');
            } catch (err) {
                console.error('Error handleAvatarSelect:', err);
                app.toast.show(err.message || 'An error occurred while uploading profile photo.', 'error');
            }
        },

        async removeAvatar() {
            const user = app.state.user;
            if (!user || user.isGuest) return;

            try {
                app.toast.show('Removing profile photo...', 'info');

                // Delete file from Storage bucket 'avatars'
                await supabaseClient.storage
                    .from('avatars')
                    .remove([`${user.id}.jpg`]);

                // Update profiles.avatar_url to NULL in Supabase
                const { error: dbError } = await supabaseClient
                    .from('profiles')
                    .update({ avatar_url: null })
                    .eq('id', user.id);

                if (dbError) {
                    console.error('Error setting avatar_url to NULL:', dbError);
                    app.toast.show('Failed to remove profile photo: ' + dbError.message, 'error');
                    return;
                }

                // Update state & localStorage
                user.avatarUrl = null;
                user.avatar_url = null;
                app.state.user = user;
                localStorage.setItem('kt_user', JSON.stringify(user));

                // Sync UI everywhere
                app.syncAuthStateDisplay();
                app.renderAvatar('profile-avatar', user);
                app.renderAvatar('usr-avatar', user);
                app.renderAvatar('edit-avatar-preview', user);

                const removeBtn = document.getElementById('btn-remove-avatar');
                if (removeBtn) removeBtn.classList.add('hidden');

                console.log('[AVATAR REMOVE SUCCESS]');
                console.log('[STATE USER]', app.state.user);

                app.toast.show('Profile photo removed successfully.', 'success');
            } catch (err) {
                console.error('Error removeAvatar:', err);
                app.toast.show('An error occurred while removing profile photo.', 'error');
            }
        }
    },

    // ======================== LEADERBOARD (ALL TIME & WEEKLY) ========================
    leaderboard: {
        dummyData: [],
        top100Cache: [],
        selectedProfile: null,
        currentTab: 'alltime',

        weeklyCountdownTimer: null,

        escapeHtml(str) {
            return app.escapeHtml(str);
        },

        generateDummyData() {
            const names = [
                'RizkyPratama', 'AndiSaputra', 'SitiNuraini', 'BudiSantoso', 'DewiLestari',
                'FajarHidayat', 'NurHaliza', 'AgusWijaya', 'RinaAmelia', 'HendraGunawan',
                'MayaSari', 'TonoSuryadi', 'LisaPutri', 'DianRahmawati', 'EkoPermadi',
                'WulanDari', 'ArdiNugroho', 'FitriHandayani', 'YusufIbrahim', 'RatnaKusuma'
            ];

            this.dummyData = names.map((name, i) => ({
                id: `dummy-${i}`,
                username: name,
                display_name: name,
                avatar_url: null,
                best_standard_score: Math.floor(Math.random() * 80 + 70) - i * 2,
                best_standard_accuracy: Math.floor(Math.random() * 15 + 82) - Math.floor(i / 5),
                best_standard_consistency: Math.floor(Math.random() * 20 + 80),
                best_standard_test_date: new Date(Date.now() - i * 3600000).toISOString(),
                created_at: new Date(Date.now() - i * 86400000 * 5).toISOString()
            })).sort((a, b) => {
                if (b.best_standard_score !== a.best_standard_score) return b.best_standard_score - a.best_standard_score;
                if (b.best_standard_accuracy !== a.best_standard_accuracy) return b.best_standard_accuracy - a.best_standard_accuracy;
                if (b.best_standard_consistency !== a.best_standard_consistency) return b.best_standard_consistency - a.best_standard_consistency;
                return new Date(a.best_standard_test_date).getTime() - new Date(b.best_standard_test_date).getTime();
            });
        },

        startWeeklyCountdown() {
            this.stopWeeklyCountdown();
            const banner = document.getElementById('lb-weekly-countdown-banner');
            if (banner) banner.classList.remove('hidden');

            const updateTimer = () => {
                const timerEl = document.getElementById('lb-weekly-countdown-timer');
                const rangeTextEl = document.getElementById('lb-weekly-range-text');

                const range = app.getCurrentWeekRangeWIB();
                if (rangeTextEl) {
                    const formatWib = (d) => `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
                    rangeTextEl.innerText = `Current Week (${formatWib(range.mondayWib)} – ${formatWib(range.sundayWib)}) • Mon 00:00 WIB – Sun 23:59 WIB`;
                }

                if (!timerEl) return;
                const diffMs = range.nextMondayUtcMs - Date.now();

                if (diffMs <= 0) {
                    timerEl.innerText = "Resetting now...";
                    app.getLeaderboardData('weekly', true).then(() => {
                        if (app.state.currentView === 'leaderboard' && app.leaderboard.currentTab === 'weekly') {
                            app.leaderboard.renderWeekly();
                        }
                    });
                    return;
                }

                const days = Math.floor(diffMs / (86400 * 1000));
                const hours = Math.floor((diffMs % (86400 * 1000)) / (3600 * 1000));
                const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
                const secs = Math.floor((diffMs % (60 * 1000)) / 1000);

                timerEl.innerText = `${days}d ${hours}h ${mins}m ${secs}s`;
            };

            updateTimer();
            this.weeklyCountdownTimer = setInterval(updateTimer, 1000);
        },

        stopWeeklyCountdown() {
            if (this.weeklyCountdownTimer) {
                clearInterval(this.weeklyCountdownTimer);
                this.weeklyCountdownTimer = null;
            }
            const banner = document.getElementById('lb-weekly-countdown-banner');
            if (banner) banner.classList.add('hidden');
        },

        switchTab(tab) {
            this.currentTab = tab;
            const globalTab = document.getElementById('lb-tab-global');
            const weeklyTab = document.getElementById('lb-tab-weekly');

            if (globalTab && weeklyTab) {
                if (tab === 'weekly') {
                    weeklyTab.className = "tab-btn bg-cyan-500 text-slate-950 px-5 py-2 rounded-lg text-sm font-extrabold transition";
                    globalTab.className = "tab-btn text-slate-400 hover:text-slate-200 px-5 py-2 rounded-lg text-sm font-extrabold transition";
                    this.startWeeklyCountdown();
                } else {
                    globalTab.className = "tab-btn bg-cyan-500 text-slate-950 px-5 py-2 rounded-lg text-sm font-extrabold transition";
                    weeklyTab.className = "tab-btn text-slate-400 hover:text-slate-200 px-5 py-2 rounded-lg text-sm font-extrabold transition";
                    this.stopWeeklyCountdown();
                }
            }

            this.render();
        },

        async render() {
            if (this.currentTab === 'weekly') {
                await this.renderWeekly();
            } else {
                await this.renderAllTime();
            }
        },

        async renderAllTime() {
            console.log('[LEADERBOARD]');
            console.log('[LEADERBOARD QUERY - SINGLE SOURCE OF TRUTH]');
            this.stopWeeklyCountdown();

            const tbody = document.getElementById('lb-table-body');
            const podiumContainer = document.getElementById('lb-podium-container');
            if (podiumContainer) podiumContainer.classList.remove('hidden');

            if (tbody) {
                tbody.innerHTML = Array(5).fill(0).map(() => `
                    <tr class="animate-pulse border-b border-slate-800/50">
                        <td class="p-4 text-center"><div class="h-4 w-6 bg-slate-800 rounded mx-auto"></div></td>
                        <td class="p-4"><div class="flex items-center space-x-3"><div class="w-7 h-7 bg-slate-800 rounded-full"></div><div class="h-4 w-28 bg-slate-800 rounded"></div></div></td>
                        <td class="p-4"><div class="h-4 w-12 bg-slate-800 rounded ml-auto"></div></td>
                        <td class="p-4"><div class="h-4 w-12 bg-slate-800 rounded mx-auto"></div></td>
                    </tr>
                `).join('');
            }

            let rankedAll = [];
            try {
                rankedAll = await app.getLeaderboardData('alltime', true);
            } catch (err) {
                console.error('[LEADERBOARD ERROR]', err);
                if (tbody) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="4" class="p-8 text-center space-y-3">
                                <div class="text-amber-400 font-bold text-base"><i class="fa-solid fa-triangle-exclamation mr-2"></i>Failed to load leaderboard.</div>
                                <button onclick="app.leaderboard.render()" class="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs rounded-lg transition shadow-md">
                                    <i class="fa-solid fa-rotate-right mr-1"></i> Retry
                                </button>
                            </td>
                        </tr>
                    `;
                }
                return;
            }

            console.log('[LEADERBOARD LOADED]', rankedAll.length);

            const top100 = rankedAll.slice(0, 100);
            this.top100Cache = top100;
            this.renderPodium(top100);
            this.renderTable(top100, "No leaderboard data available yet.");
            await this.renderUserRankCard(rankedAll, 'alltime');
        },

        async renderWeekly() {
            console.log('[WEEKLY LEADERBOARD - WIB SINGLE SOURCE OF TRUTH]');
            this.startWeeklyCountdown();

            const tbody = document.getElementById('lb-table-body');
            const podiumContainer = document.getElementById('lb-podium-container');

            if (tbody) {
                tbody.innerHTML = Array(5).fill(0).map(() => `
                    <tr class="animate-pulse border-b border-slate-800/50">
                        <td class="p-4 text-center"><div class="h-4 w-6 bg-slate-800 rounded mx-auto"></div></td>
                        <td class="p-4"><div class="flex items-center space-x-3"><div class="w-7 h-7 bg-slate-800 rounded-full"></div><div class="h-4 w-28 bg-slate-800 rounded"></div></div></td>
                        <td class="p-4"><div class="h-4 w-12 bg-slate-800 rounded ml-auto"></div></td>
                        <td class="p-4"><div class="h-4 w-12 bg-slate-800 rounded mx-auto"></div></td>
                    </tr>
                `).join('');
            }

            let rankedWeekly = [];
            try {
                rankedWeekly = await app.getLeaderboardData('weekly', true);
            } catch (err) {
                console.error('[WEEKLY LEADERBOARD ERROR]', err);
                if (tbody) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="4" class="p-8 text-center space-y-3">
                                <div class="text-amber-400 font-bold text-base"><i class="fa-solid fa-triangle-exclamation mr-2"></i>Failed to load Weekly Leaderboard.</div>
                                <button onclick="app.leaderboard.render()" class="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs rounded-lg transition shadow-md">
                                    <i class="fa-solid fa-rotate-right mr-1"></i> Retry
                                </button>
                            </td>
                        </tr>
                    `;
                }
                return;
            }

            if (rankedWeekly.length === 0) {
                // EMPTY STATE for Weekly Leaderboard (Current week reset)
                if (podiumContainer) podiumContainer.classList.add('hidden');
                if (tbody) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="4" class="p-10 text-center space-y-3">
                                <div class="text-4xl">🏆</div>
                                <h3 class="text-base font-extrabold text-slate-200">No test results yet this week</h3>
                                <p class="text-xs text-slate-400 max-w-xs mx-auto">Be the first player to claim the #1 spot on this week's leaderboard!</p>
                                <button onclick="app.navigate('test-menu')" class="px-5 py-2.5 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black text-xs rounded-xl transition shadow-lg shadow-cyan-500/20 inline-flex items-center gap-2 mt-2">
                                    <i class="fa-solid fa-play"></i> Start Test
                                </button>
                            </td>
                        </tr>
                    `;
                }
                await this.renderUserRankCard([], 'weekly');
                return;
            }

            if (podiumContainer) podiumContainer.classList.remove('hidden');
            const top100 = rankedWeekly.slice(0, 100);
            this.top100Cache = top100;
            this.renderPodium(top100);
            this.renderTable(top100, "No Weekly Leaderboard data available yet.");
            await this.renderUserRankCard(rankedWeekly, 'weekly');
        },

        renderTable(top100, emptyMessage) {
            const tbody = document.getElementById('lb-table-body');
            if (!tbody) return;
            tbody.innerHTML = '';

            if (top100.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="4" class="p-8 text-center text-slate-500 italic">
                            ${emptyMessage}
                        </td>
                    </tr>
                `;
            } else {
                const tableItems = top100.length > 3 ? top100.slice(3) : top100;
                tableItems.forEach((entry) => {
                    const row = document.createElement('tr');
                    const isCurrentUser = app.state.user && !app.state.user.isGuest && entry.id === app.state.user.id;

                    row.className = `hover:bg-slate-800/60 active:bg-slate-800 transition border-b border-slate-800/50 cursor-pointer ${
                        isCurrentUser ? 'bg-cyan-500/10 border-l-4 border-cyan-400 font-bold' : ''
                    }`;
                    row.onclick = () => app.leaderboard.onRowClick(entry.id);

                    const rawName = entry.display_name || entry.username || 'User';
                    const effectiveName = app.escapeHtml(rawName);
                    const safeUsername = app.escapeHtml(entry.username || 'user');
                    const safeAvatarUrl = entry.avatar_url && typeof entry.avatar_url === 'string' &&
                        (entry.avatar_url.startsWith('http://') || entry.avatar_url.startsWith('https://') || entry.avatar_url.startsWith('data:image/'))
                        ? app.escapeHtml(entry.avatar_url.trim())
                        : null;

                    const avatarHtml = safeAvatarUrl
                        ? `<img src="${safeAvatarUrl}" alt="Avatar" class="w-8 h-8 rounded-full object-cover">`
                        : `<div class="w-8 h-8 bg-cyan-500/20 text-cyan-400 font-bold rounded-full flex items-center justify-center text-xs border border-cyan-500/30 flex-shrink-0">${rawName.charAt(0).toUpperCase()}</div>`;

                    let rankDisplay = `#${entry.rank}`;
                    if (entry.rank === 1) rankDisplay = '🥇 #1';
                    else if (entry.rank === 2) rankDisplay = '🥈 #2';
                    else if (entry.rank === 3) rankDisplay = '🥉 #3';

                    row.innerHTML = `
                        <td class="p-4 font-extrabold text-slate-400 text-sm text-center">${rankDisplay}</td>
                        <td class="p-4">
                            <div class="flex items-center space-x-3">
                                ${avatarHtml}
                                <div class="flex flex-col">
                                    <span class="text-sm font-extrabold ${isCurrentUser ? 'text-cyan-300' : 'text-slate-100'}">${effectiveName} ${isCurrentUser ? '(You)' : ''}</span>
                                    <span class="text-[11px] text-slate-500 font-mono">@${safeUsername}</span>
                                </div>
                            </div>
                        </td>
                        <td class="p-4 font-extrabold text-cyan-400 text-sm text-right">${entry.score}</td>
                        <td class="p-4 text-emerald-400 text-sm text-center font-bold">${entry.accuracy}%</td>
                    `;
                    tbody.appendChild(row);
                });
            }
        },

        async renderUserRankCard(dataset, mode) {
            const yourPos = document.getElementById('lb-your-position');
            if (!yourPos) return;

            if (!app.state.user || app.state.user.isGuest) {
                yourPos.classList.add('hidden');
                return;
            }

            const foundIndex = dataset.findIndex(p => p.id === app.state.user.id);
            const el = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };
            const subLabel = document.querySelector('#lb-your-position p.text-xs.text-slate-400');

            yourPos.classList.remove('hidden');
            app.renderAvatar('lb-your-avatar', app.state.user);
            const effectiveName = (app.state.user.displayName && app.state.user.displayName.trim() !== '') ? app.state.user.displayName.trim() : (app.state.user.username || 'User');
            el('lb-your-name', effectiveName);

            if (foundIndex !== -1) {
                const userMatch = dataset[foundIndex];
                const userRank = userMatch.rank || (foundIndex + 1);
                el('lb-your-rank', '#' + userRank);
                el('lb-your-score', userMatch.score + ' pts');
                el('lb-your-acc', userMatch.accuracy + '% accuracy');
                if (subLabel) subLabel.innerText = mode === 'weekly' ? 'Your Weekly Rank' : 'Your current position';
            } else {
                if (mode === 'weekly') {
                    el('lb-your-rank', 'Not Ranked Yet');
                    el('lb-your-score', '0 pts');
                    el('lb-your-acc', '0% accuracy');
                    if (subLabel) subLabel.innerText = 'Complete your first test this week to enter the leaderboard.';
                } else {
                    el('lb-your-rank', 'Unranked');
                    el('lb-your-score', '0 pts');
                    el('lb-your-acc', '0% accuracy');
                    if (subLabel) subLabel.innerText = 'Complete a Standard Test to get ranked.';
                }
            }
        },

        renderPodium(data) {
            const p1 = data[0];
            const p2 = data[1];
            const p3 = data[2];

            const updateSlot = (rank, entry) => {
                const avatarEl = document.getElementById(`lb-podium-avatar-${rank}`);
                const nameEl = document.getElementById(`lb-podium-name-${rank}`);
                const scoreEl = document.getElementById(`lb-podium-score-${rank}`);

                if (!entry) {
                    if (nameEl) nameEl.innerText = '—';
                    if (scoreEl) scoreEl.innerText = '0 pts';
                    if (avatarEl) avatarEl.innerText = '?';
                    return;
                }

                const effectiveName = entry.display_name || entry.username || 'User';
                const score = entry.score !== undefined ? entry.score : (entry.best_standard_score || 0);

                if (nameEl) nameEl.innerText = effectiveName;
                if (scoreEl) scoreEl.innerText = `${score} pts`;

                if (avatarEl) {
                    if (entry.avatar_url) {
                        avatarEl.innerHTML = `<img src="${entry.avatar_url}" alt="Avatar" class="w-full h-full object-cover rounded-full">`;
                    } else {
                        avatarEl.innerText = effectiveName.charAt(0).toUpperCase();
                    }
                }
            };

            updateSlot(1, p1);
            updateSlot(2, p2);
            updateSlot(3, p3);
        },

        onRowClick(userId) {
            this.openProfilePreview(userId);
        },

        onRowClickByRank(rank) {
            const player = (this.top100Cache || []).find(p => p.rank === rank);
            if (player) {
                this.onRowClick(player.id);
            }
        },

        async openProfilePreview(userIdOrSpecial) {
            console.log('[PROFILE PREVIEW OPENED]');
            const modal = document.getElementById('modal-profile-preview');
            if (!modal) return;

            let targetUserId = userIdOrSpecial;
            let targetProfile = null;

            if (userIdOrSpecial === 'self' && app.state.user) {
                targetUserId = app.state.user.id;
                targetProfile = app.state.user;
            } else {
                targetProfile = (this.top100Cache || []).find(p => p.id === userIdOrSpecial);
            }

            if (!targetProfile && targetUserId && targetUserId !== 'self') {
                try {
                    const { data } = await supabaseClient
                        .from('profiles')
                        .select('*')
                        .eq('id', targetUserId)
                        .maybeSingle();

                    if (data) targetProfile = data;
                } catch (e) {
                    console.error('Error openProfilePreview:', e);
                }
            }

            if (!targetProfile) {
                app.toast.show('Profil pengguna tidak ditemukan.', 'warning');
                return;
            }

            this.selectedProfile = targetProfile;

            const selectedUserId = targetProfile.id;
            const authUserId = app.state.user ? app.state.user.id : null;

            let bestTestRecord = null;
            if (selectedUserId && !String(selectedUserId).startsWith('dummy-')) {
                try {
                    const { data, error } = await supabaseClient
                        .from('test_results')
                        .select('id, user_id, score, raw_score, accuracy, consistency, correct_answers, wrong_answers, created_at, mode, is_valid, is_flagged')
                        .eq('user_id', selectedUserId)
                        .in('mode', ['Standard Test', 'Standard', 'standard'])
                        .not('is_valid', 'eq', false)
                        .not('is_flagged', 'eq', true)
                        .order('score', { ascending: false })
                        .order('accuracy', { ascending: false })
                        .order('consistency', { ascending: false })
                        .order('created_at', { ascending: true })
                        .limit(1);

                    if (!error && data && data.length > 0) {
                        bestTestRecord = data[0];
                    } else if (error) {
                        const { data: fallbackData } = await supabaseClient
                            .from('test_results')
                            .select('id, user_id, score, raw_score, accuracy, consistency, correct_answers, wrong_answers, created_at, mode')
                            .eq('user_id', selectedUserId)
                            .order('score', { ascending: false })
                            .limit(1);

                        if (fallbackData && fallbackData.length > 0) {
                            bestTestRecord = fallbackData[0];
                        }
                    }
                } catch (err) {
                    console.error('Error fetching best test record for user:', selectedUserId, err);
                }
            }

            const correctAns = bestTestRecord
                ? (bestTestRecord.correct_answers !== undefined ? bestTestRecord.correct_answers : (bestTestRecord.correctAnswers !== undefined ? bestTestRecord.correctAnswers : null))
                : null;

            const wrongAns = bestTestRecord
                ? (bestTestRecord.wrong_answers !== undefined ? bestTestRecord.wrong_answers : (bestTestRecord.wrongAnswers !== undefined ? bestTestRecord.wrongAnswers : null))
                : null;

            // TEMPORARY DEBUG LOGS FOR VERIFICATION
            console.log('[LEADERBOARD MODAL DEBUG]', {
                selectedLeaderboardUserId: selectedUserId,
                authenticatedUserId: authUserId,
                queriedUserId: selectedUserId,
                bestTestResultId: bestTestRecord ? bestTestRecord.id : null,
                correctAnswers: correctAns,
                wrongAnswers: wrongAns
            });

            const effectiveName = targetProfile.display_name || targetProfile.username || 'User';
            const username = targetProfile.username || 'user';

            // Extract performance metrics from the selected user's single best record
            const score = bestTestRecord
                ? bestTestRecord.score
                : (targetProfile.best_standard_score !== undefined ? targetProfile.best_standard_score : (targetProfile.score || 0));

            const accuracy = bestTestRecord
                ? bestTestRecord.accuracy
                : (targetProfile.best_standard_accuracy !== undefined ? targetProfile.best_standard_accuracy : (targetProfile.accuracy || 0));

            const consistency = bestTestRecord
                ? bestTestRecord.consistency
                : (targetProfile.best_standard_consistency !== undefined ? targetProfile.best_standard_consistency : (targetProfile.consistency || 100));

            // Find rank
            const rankInTop = targetProfile.rank || ((this.top100Cache || []).findIndex(p => p.id === selectedUserId) + 1);
            const rankText = rankInTop > 0 ? `#${rankInTop}` : '—';

            const el = (id, val) => { const e = document.getElementById(id); if (e) e.innerText = val; };
            el('profile-preview-name', effectiveName);
            el('profile-preview-username', `@${username}`);
            el('profile-preview-rank', rankText);
            el('profile-preview-score', `${score} pts`);
            el('profile-preview-accuracy', `${accuracy}%`);
            el('profile-preview-consistency', consistency != null ? `${consistency}%` : '—');
            el('profile-preview-correct', correctAns !== null ? `${correctAns} soal` : '—');
            el('profile-preview-wrong', wrongAns !== null ? `${wrongAns} soal` : '—');

            // Render Avatar
            const avatarContainer = document.getElementById('profile-preview-avatar');
            if (avatarContainer) {
                const avatarUrl = targetProfile.avatar_url || targetProfile.avatarUrl;
                if (avatarUrl) {
                    avatarContainer.innerHTML = `<img src="${avatarUrl}" alt="Avatar" class="w-full h-full object-cover rounded-full">`;
                } else {
                    avatarContainer.innerText = effectiveName.charAt(0).toUpperCase();
                }
            }

            modal.classList.remove('hidden');
        },

        closeProfilePreview() {
            const modal = document.getElementById('modal-profile-preview');
            if (modal) modal.classList.add('hidden');
            this.selectedProfile = null;
        },

        viewFullProfile() {
            app.toast.show('Akses profil publik di-blokir.', 'warning');
        }
    },

    // ======================== ARTICLES ========================
    articles: {
        data: [],

        init() {
            this.data = [
                {
                    title: 'Panduan Lengkap Menghadapi Tes Pauli & Kraepelin',
                    slug: 'panduan-tes-pauli',
                    date: '20 Jul 2026',
                    excerpt: 'Pelajari strategi dan teknik terbaik untuk menghadapi tes koran dalam seleksi kerja. Dari persiapan mental hingga teknik menghitung cepat.',
                    content: `<p>Tes Pauli dan Kraepelin merupakan salah satu instrumen psikotes yang paling umum digunakan dalam proses rekrutmen kerja di Indonesia. Tes ini dirancang untuk mengukur kemampuan konsentrasi, kecepatan kerja, ketelitian, dan daya tahan mental seseorang.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">Apa Itu Tes Koran?</h3>
                    <p>Tes Koran mendapatkan namanya karena lembar soalnya yang menyerupai halaman koran — berisi deretan angka-angka yang harus dijumlahkan secara berurutan. Peserta diminta menjumlahkan dua angka yang berdekatan secara vertikal dan menuliskan angka satuan dari hasil penjumlahan tersebut.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">Tips Menghadapi Tes</h3>
                    <ul class="list-disc list-inside space-y-1"><li>Jaga ritme pengerjaan yang konsisten</li><li>Fokus pada ketelitian, bukan hanya kecepatan</li><li>Latihan rutin minimal 3x seminggu</li><li>Istirahat cukup sebelum hari tes</li><li>Hindari panik saat menemui kesalahan</li></ul>`
                },
                {
                    title: '5 Kesalahan Umum Saat Mengerjakan Tes Koran',
                    slug: 'kesalahan-umum-tes-koran',
                    date: '18 Jul 2026',
                    excerpt: 'Hindari kesalahan-kesalahan fatal ini agar performa tes koran Anda optimal dan grafik perkembangan tetap stabil.',
                    content: `<p>Banyak peserta tes koran melakukan kesalahan yang sebenarnya bisa dihindari dengan persiapan yang tepat. Berikut adalah lima kesalahan yang paling umum ditemui:</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">1. Terlalu Fokus pada Kecepatan</h3>
                    <p>Banyak peserta berpikir bahwa semakin cepat mengerjakan semakin baik. Padahal, penilai juga memantau konsistensi dan ketelitian Anda.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">2. Tidak Berlatih Sebelumnya</h3>
                    <p>Tes koran membutuhkan kebiasaan motorik. Tanpa latihan, Anda akan kehilangan waktu untuk adaptasi saat hari tes.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">3. Panik Saat Salah</h3>
                    <p>Kesalahan kecil bisa membuat peserta panik dan merusak ritme pengerjaan selanjutnya. Tetap tenang dan lanjutkan ke soal berikutnya.</p>`
                },
                {
                    title: 'Cara Membaca Hasil Tes Kraepelin dengan Benar',
                    slug: 'membaca-hasil-kraepelin',
                    date: '15 Jul 2026',
                    excerpt: 'Pahami arti dari setiap metrik hasil tes Kraepelin: kecepatan, ketelitian, konsistensi, dan grafik perkembangan performa.',
                    content: `<p>Setelah mengerjakan tes Kraepelin, Anda akan menerima beberapa metrik utama yang mencerminkan performa Anda selama pengerjaan:</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">Kecepatan (Speed)</h3>
                    <p>Menunjukkan berapa banyak soal yang berhasil Anda jawab dalam durasi tes. Semakin tinggi angka ini, semakin cepat tempo kerja Anda.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">Ketelitian (Accuracy)</h3>
                    <p>Persentase jawaban yang benar dari total soal yang dijawab. Idealnya di atas 90% untuk menunjukkan ketelitian yang baik.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">Konsistensi (Consistency)</h3>
                    <p>Mengukur seberapa stabil performa Anda dari awal hingga akhir tes. Grafik yang naik-turun menunjukkan ketidakstabilan fokus.</p>`
                },
                {
                    title: 'Persiapan Mental Sebelum Psikotes Kerja',
                    slug: 'persiapan-mental-psikotes',
                    date: '12 Jul 2026',
                    excerpt: 'Kesiapan mental sama pentingnya dengan latihan teknis. Pelajari cara mengelola stres dan membangun kepercayaan diri sebelum psikotes.',
                    content: `<p>Persiapan mental sering kali diabaikan oleh banyak peserta psikotes. Padahal, kondisi mental yang baik sangat berpengaruh terhadap performa Anda saat tes.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">Tidur yang Cukup</h3>
                    <p>Pastikan Anda tidur minimal 7-8 jam sebelum hari tes. Kurang tidur akan menurunkan konsentrasi dan kecepatan motorik Anda secara signifikan.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">Teknik Pernapasan</h3>
                    <p>Latih teknik pernapasan 4-7-8 sebelum tes dimulai: hirup napas selama 4 detik, tahan 7 detik, hembuskan selama 8 detik. Ini membantu menenangkan sistem saraf.</p>
                    <h3 class="text-lg font-bold text-slate-100 mt-6 mb-2">Visualisasi Positif</h3>
                    <p>Bayangkan diri Anda mengerjakan tes dengan lancar dan percaya diri. Teknik ini terbukti meningkatkan performa dalam berbagai situasi yang menuntut fokus tinggi.</p>`
                }
            ];
        },

        renderList() {
            const grid = document.getElementById('articles-grid');
            if (!grid) return;

            grid.innerHTML = this.data.map((article, i) => `
                <div class="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden group cursor-pointer" onclick="app.articles.viewDetail(${i})">
                    <div class="h-40 bg-slate-800 overflow-hidden">
                        <div class="w-full h-full bg-gradient-to-br ${['from-cyan-500/20 to-purple-500/20', 'from-emerald-500/20 to-cyan-500/20', 'from-amber-500/20 to-red-500/20', 'from-indigo-500/20 to-pink-500/20'][i]} group-hover:scale-105 transition-transform duration-300 flex items-center justify-center">
                            <i class="fa-solid ${['fa-book-open', 'fa-triangle-exclamation', 'fa-chart-line', 'fa-brain'][i]} text-3xl text-slate-600"></i>
                        </div>
                    </div>
                    <div class="p-4 space-y-2">
                        <span class="text-[10px] text-slate-500 font-bold uppercase">${article.date}</span>
                        <h4 class="font-bold text-sm text-slate-100 group-hover:text-cyan-400 transition">${article.title}</h4>
                        <p class="text-xs text-slate-500 line-clamp-2">${article.excerpt}</p>
                    </div>
                </div>
            `).join('');
        },

        viewDetail(index) {
            const article = this.data[index];
            if (!article) return;

            const el = (id, val, html = false) => {
                const e = document.getElementById(id);
                if (e) { html ? e.innerHTML = val : e.innerText = val; }
            };

            el('article-detail-title', article.title);
            el('article-detail-date', article.date);
            el('article-detail-content', article.content, true);

            app.navigate('article-detail');
        }
    },

    // ======================== ADMIN ========================
    admin: {
        currentPanel: 'dashboard',

        auth() {
            const u = document.getElementById('adm-u')?.value;
            const p = document.getElementById('adm-p')?.value;
            if (u === 'user123' && p === 'user123') {
                const loginScreen = document.getElementById('admin-login-screen');
                const dashPanel = document.getElementById('admin-dashboard-panel');
                const sidebar = document.getElementById('admin-sidebar');
                if (loginScreen) loginScreen.classList.add('hidden');
                if (dashPanel) dashPanel.classList.remove('hidden');
                if (sidebar) sidebar.classList.remove('hidden');
                this.switchPanel('dashboard');
                app.toast.show('Login admin berhasil!', 'success');
            } else {
                app.toast.show('Credential Administrator salah.', 'error');
            }
        },

        logout() {
            const loginScreen = document.getElementById('admin-login-screen');
            const dashPanel = document.getElementById('admin-dashboard-panel');
            const sidebar = document.getElementById('admin-sidebar');
            if (loginScreen) loginScreen.classList.remove('hidden');
            if (dashPanel) dashPanel.classList.add('hidden');
            if (sidebar) sidebar.classList.add('hidden');

            // Hide all admin panels
            document.querySelectorAll('[id^="admin-"][id$="-panel"]').forEach(p => p.classList.add('hidden'));

            app.navigate('home');
        },

        switchPanel(panelName) {
            this.currentPanel = panelName;

            // Hide all admin sub-panels
            const panels = ['dashboard', 'users', 'results', 'articles', 'announcements', 'badges'];
            panels.forEach(p => {
                const panel = document.getElementById(`admin-${p}-panel`);
                if (panel) panel.classList.add('hidden');
            });

            // Show target panel
            const target = document.getElementById(`admin-${panelName}-panel`);
            if (target) target.classList.remove('hidden');

            // Update sidebar active state
            document.querySelectorAll('.admin-sidebar-item').forEach(item => {
                item.classList.remove('active');
            });
            const activeItem = document.querySelector(`[data-admin-panel="${panelName}"]`);
            if (activeItem) activeItem.classList.add('active');
        }
    },

    // ======================== AUTOMATIC INACTIVITY LOGOUT SYSTEM ========================
    inactivity: {
        inactivityTimer: null,
        warningCountdownTimer: null,
        secondsRemaining: 60,
        lastActivityTime: 0,
        isWarningShown: false,
        isListening: false,
        
        INACTIVITY_LIMIT_MS: 4 * 60 * 1000, // 4 minutes before warning dialog (5 minutes total)
        WARNING_COUNTDOWN_SEC: 60,          // 60 seconds warning countdown

        init() {
            if (this.isListening) return;

            const activityEvents = ['mousemove', 'click', 'keydown', 'scroll', 'touchstart', 'pointerdown'];
            activityEvents.forEach(evt => {
                window.addEventListener(evt, () => this.onUserActivity(), { passive: true });
            });
            this.isListening = true;
        },

        startMonitoring() {
            this.stopMonitoring();
            
            // Only monitor if user is logged in (not guest) and no test is currently running
            const user = app.state.user;
            if (!user || user.isGuest || app.state.isTestRunning) {
                return;
            }

            this.init();
            this.lastActivityTime = Date.now();
            this.isWarningShown = false;

            this.inactivityTimer = setTimeout(() => {
                this.showWarning();
            }, this.INACTIVITY_LIMIT_MS);
        },

        stopMonitoring() {
            if (this.inactivityTimer) {
                clearTimeout(this.inactivityTimer);
                this.inactivityTimer = null;
            }
            if (this.warningCountdownTimer) {
                clearInterval(this.warningCountdownTimer);
                this.warningCountdownTimer = null;
            }
            this.isWarningShown = false;
            this.hideWarningModal();
        },

        onUserActivity() {
            // Do not reset timer while warning modal is shown or test is running or user is not logged in / guest
            if (this.isWarningShown || app.state.isTestRunning || !app.state.user || app.state.user.isGuest) {
                return;
            }

            // Throttle activity handling to once per second
            const now = Date.now();
            if (now - this.lastActivityTime < 1000) {
                return;
            }
            this.lastActivityTime = now;

            // Reset inactivity timer
            if (this.inactivityTimer) {
                clearTimeout(this.inactivityTimer);
            }
            this.inactivityTimer = setTimeout(() => {
                this.showWarning();
            }, this.INACTIVITY_LIMIT_MS);
        },

        showWarning() {
            if (app.state.isTestRunning || !app.state.user || app.state.user.isGuest) {
                return;
            }

            this.isWarningShown = true;
            this.secondsRemaining = this.WARNING_COUNTDOWN_SEC;

            const modal = document.getElementById('modal-inactivity-warning');
            const countdownEl = document.getElementById('inactivity-countdown');
            if (countdownEl) countdownEl.innerText = this.secondsRemaining;
            if (modal) modal.classList.remove('hidden');

            if (this.warningCountdownTimer) clearInterval(this.warningCountdownTimer);

            this.warningCountdownTimer = setInterval(() => {
                this.secondsRemaining--;
                if (countdownEl) countdownEl.innerText = this.secondsRemaining;

                if (this.secondsRemaining <= 0) {
                    clearInterval(this.warningCountdownTimer);
                    this.warningCountdownTimer = null;
                    this.handleAutoLogout(true);
                }
            }, 1000);
        },

        hideWarningModal() {
            const modal = document.getElementById('modal-inactivity-warning');
            if (modal) modal.classList.add('hidden');
        },

        handleStayLoggedIn() {
            this.hideWarningModal();
            if (this.warningCountdownTimer) {
                clearInterval(this.warningCountdownTimer);
                this.warningCountdownTimer = null;
            }
            this.isWarningShown = false;
            this.startMonitoring();
        },

        async handleSignOut() {
            this.stopMonitoring();
            await app.actions.logout();
        },

        async handleAutoLogout(isTimeout = true) {
            this.stopMonitoring();
            await app.actions.logout();
            if (isTimeout) {
                app.toast.show("You've been signed out due to inactivity.", 'info');
            }
        }
    }
};

// Run application on load
window.onload = () => {
    app.init();
    // Render articles if on articles page
    if (app.state.currentView === 'articles') {
        app.articles.renderList();
    }
};
