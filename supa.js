// Conexão com o Supabase (a publishable key pode ficar no navegador; a segurança vem das regras RLS)
window.SB_URL = 'https://vphvzjjpwgzcqrsxabqo.supabase.co';
window.SB_KEY = 'sb_publishable_Jwv9CY41dIlUUqTaJFSAuQ_BxSyj12t';
window.sb = window.supabase.createClient(window.SB_URL, window.SB_KEY);
