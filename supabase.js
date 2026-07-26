const SUPABASE_URL = "https://eumrsfiaxhpzonjipwmm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_5uq7erGzsyPnRYQUYfQtdw_J7H4vpQT";

const supabaseClient = supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);