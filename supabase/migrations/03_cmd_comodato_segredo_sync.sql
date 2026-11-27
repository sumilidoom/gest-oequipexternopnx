-- Chave usada pelo pg_cron para chamar a funcao cmd-sync-sankhya. O valor e gerado no proprio banco.
create table public.cmd_segredos (
  chave text primary key,
  valor text not null
);
alter table public.cmd_segredos enable row level security;
-- sem policies: so service_role/postgres acessam
insert into public.cmd_segredos (chave, valor) values ('cron_secret', encode(gen_random_bytes(24), 'hex'));
