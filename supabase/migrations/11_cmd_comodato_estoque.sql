-- Estoque de equipamentos (Matriz e Teresina), copiado do Sankhya (TGFEST) a cada sincronizacao.
-- Equipamento = produto que ja saiu em comodato (menos revenda) ou produto do grupo de equipamentos
-- (cmd_config.estoque_grupo_equipamentos) marcado como imobilizado (USOPROD = I).
-- tipo/codparc seguem o Sankhya:
--   P + codparc 0  -> guardado na empresa
--   P + codparc    -> nosso, em poder do cliente (o Sankhya so conhece as remessas desde ago/2024)
--   T              -> o Sankhya trata como bem de terceiro (ex.: devolucao lancada na TOP 1986)

insert into public.cmd_config (chave, valor) values ('estoque_grupo_equipamentos', '90000')
on conflict (chave) do nothing;

alter table public.cmd_produtos
  add column if not exists usoprod text,
  add column if not exists codgrupoprod integer;

create table public.cmd_estoque (
  codemp        integer not null,
  codlocal      integer not null,
  descrlocal    text,
  codprod       integer not null,
  tipo          text not null,
  codparc       integer not null default 0,
  nomeparc      text,
  estoque       numeric not null,
  reservado     numeric not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (codemp, codlocal, codprod, tipo, codparc)
);
alter table public.cmd_estoque enable row level security;
create policy cmd_estoque_ler on public.cmd_estoque for select to authenticated using (public.cmd_tem_acesso());
revoke all on public.cmd_estoque from anon;

-- Troca a copia inteira de uma vez (so a funcao de sincronizacao chama).
create or replace function public.cmd_estoque_substituir(p_linhas jsonb)
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  delete from public.cmd_estoque where true;
  insert into public.cmd_estoque (codemp, codlocal, descrlocal, codprod, tipo, codparc, nomeparc, estoque, reservado)
  select (e->>'codemp')::int, (e->>'codlocal')::int, e->>'descrlocal', (e->>'codprod')::int, e->>'tipo',
         coalesce((e->>'codparc')::int, 0), e->>'nomeparc', (e->>'estoque')::numeric, coalesce((e->>'reservado')::numeric, 0)
    from jsonb_array_elements(p_linhas) e;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.cmd_estoque_substituir(jsonb) from public, anon, authenticated;
grant execute on function public.cmd_estoque_substituir(jsonb) to service_role;

create or replace view public.cmd_v_estoque with (security_invoker = true) as
select e.codemp,
       case e.codemp when 1 then 'Matriz' when 5 then 'Teresina' else 'Empresa ' || e.codemp end as empresa,
       e.codlocal, e.descrlocal, e.codprod,
       coalesce(p.descricao, 'PRODUTO ' || e.codprod) as produto,
       case when e.tipo = 'P' and e.codparc = 0 then 'EM_ESTOQUE'
            when e.tipo = 'P' then 'EM_CLIENTE'
            else 'DE_TERCEIROS' end as situacao,
       e.codparc, e.nomeparc, e.estoque, e.reservado, e.atualizado_em
  from public.cmd_estoque e
  left join public.cmd_produtos p on p.codprod = e.codprod;
revoke all on public.cmd_v_estoque from anon;
