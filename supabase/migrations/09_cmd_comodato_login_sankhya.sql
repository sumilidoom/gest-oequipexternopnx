-- Login com usuario e senha do Sankhya (como no Sistema Coletor).
-- A Edge Function cmd-login valida no Sankhya e abre uma sessao do Supabase para um usuario
-- "sombra" ligado ao NOMUSU. So esses usuarios enxergam e mexem nos comodatos; logins de
-- outros sistemas do mesmo projeto Supabase deixam de ter acesso.

create table public.cmd_usuarios (
  nomusu        text primary key,                 -- usuario do Sankhya (TSIUSU.NOMUSU), em maiusculas
  user_id       uuid not null unique references auth.users (id) on delete cascade,
  ativo         boolean not null default true,    -- false bloqueia o acesso na hora
  criado_em     timestamptz not null default now(),
  ultimo_login  timestamptz
);
alter table public.cmd_usuarios enable row level security;
-- sem policies: so a Edge Function (service_role) le e grava

create or replace function public.cmd_tem_acesso()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cmd_usuarios where user_id = auth.uid() and ativo);
$$;
revoke all on function public.cmd_tem_acesso() from public, anon;
grant execute on function public.cmd_tem_acesso() to authenticated;

-- Leitura: so usuarios do Sankhya ativos nos comodatos.
do $$
declare t text;
begin
  foreach t in array array['cmd_config','cmd_clientes','cmd_clientes_codigos','cmd_produtos',
                           'cmd_notas','cmd_notas_itens','cmd_saldo_inicial','cmd_sync_log'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ler', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.cmd_tem_acesso())', t || '_ler', t);
  end loop;
end $$;

-- Funcoes de escrita: trocam "estar logado" por "ter acesso aos comodatos".
do $$
declare f text; def text;
begin
  foreach f in array array['cmd_definir_data_corte(date)', 'cmd_importar_planilha(jsonb,date)',
                           'cmd_ligar_cliente_sankhya(bigint,integer)', 'cmd_vincular_retorno(bigint,bigint)'] loop
    def := pg_get_functiondef(('public.' || f)::regprocedure);
    def := replace(def, 'if auth.uid() is null then', 'if not public.cmd_tem_acesso() then');
    def := replace(def, '''login necessario''', '''sem acesso aos comodatos''');
    execute def;
  end loop;

  def := pg_get_functiondef('public.cmd_sugerir_data_corte()'::regprocedure);
  def := replace(def, 'from datas d order by', 'from datas d where public.cmd_tem_acesso() order by');
  execute def;
end $$;
