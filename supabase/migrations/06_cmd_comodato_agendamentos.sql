-- Agendamentos pg_cron da sincronizacao com o Sankhya.
-- A chave do cron e lida da tabela cmd_segredos (nao fica no codigo).
select cron.schedule('cmd_comodato_sync_5min', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://vwhfflldmgeowfaznddh.supabase.co/functions/v1/cmd-sync-sankhya',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key',(select valor from public.cmd_segredos where chave='cron_secret')),
    body := '{"dias":15}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

select cron.schedule('cmd_comodato_sync_completo_diario', '40 3 * * *', $$
  select net.http_post(
    url := 'https://vwhfflldmgeowfaznddh.supabase.co/functions/v1/cmd-sync-sankhya',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-key',(select valor from public.cmd_segredos where chave='cron_secret')),
    body := '{"completo":true}'::jsonb,
    timeout_milliseconds := 150000
  );
$$);
