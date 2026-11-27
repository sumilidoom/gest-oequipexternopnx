-- Sistema de saldo de comodatos (prefixo cmd_). Independente das tabelas comodato_* existentes.

create table public.cmd_config (
  chave text primary key,
  valor text,
  atualizado_em timestamptz not null default now()
);
comment on table public.cmd_config is 'Comodatos: configuracoes (data_corte da planilha, TOPs).';

insert into public.cmd_config (chave, valor) values
  ('tops_remessa', '1156'),
  ('tops_retorno', '1256,1271,1997'),
  ('codparc_pannemix', '1'),
  ('data_corte_planilha', null);

create table public.cmd_clientes (
  id bigint generated always as identity primary key,
  codparc integer unique,
  codigo_planilha text unique,
  nome text not null,
  cnpj_cpf text,
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on table public.cmd_clientes is 'Comodatos: clientes. codparc = Sankhya; codigo_planilha = codigo da planilha (000xxx ou Sxxx).';

create table public.cmd_produtos (
  codprod integer primary key,
  descricao text not null,
  atualizado_em timestamptz not null default now()
);

create table public.cmd_notas (
  nunota bigint primary key,
  numnota bigint,
  codtipoper integer not null,
  tipo text not null check (tipo in ('REMESSA','RETORNO')),
  dtneg date not null,
  codparc integer,
  statusnota text,
  observacao text,
  cliente_id bigint references public.cmd_clientes(id),
  vinculo_manual boolean not null default false,
  vinculado_por uuid,
  vinculado_em timestamptz,
  sincronizado_em timestamptz not null default now()
);
comment on column public.cmd_notas.cliente_id is 'Cliente a quem a nota se refere. Automatico pelo codparc; manual quando a nota foi emitida para a propria Pannemix.';
create index cmd_notas_dtneg_idx on public.cmd_notas (dtneg);
create index cmd_notas_cliente_idx on public.cmd_notas (cliente_id);

create table public.cmd_notas_itens (
  nunota bigint not null references public.cmd_notas(nunota) on delete cascade,
  sequencia integer not null,
  codprod integer not null,
  qtd numeric not null,
  vlrunit numeric,
  primary key (nunota, sequencia)
);
create index cmd_notas_itens_prod_idx on public.cmd_notas_itens (codprod);

create table public.cmd_saldo_inicial (
  id bigint generated always as identity primary key,
  cliente_id bigint not null references public.cmd_clientes(id),
  codprod integer not null,
  qtd numeric not null,
  vlrunit numeric,
  linha_planilha integer,
  importado_em timestamptz not null default now()
);
create index cmd_saldo_inicial_cli_idx on public.cmd_saldo_inicial (cliente_id, codprod);

create table public.cmd_sync_log (
  id bigint generated always as identity primary key,
  iniciado_em timestamptz not null default now(),
  finalizado_em timestamptz,
  ok boolean,
  notas_lidas integer,
  notas_gravadas integer,
  notas_removidas integer,
  erro text
);

-- Movimentos que compoem o saldo: planilha (foto na data de corte) + notas Sankhya liberadas apos o corte.
create view public.cmd_v_movimentos with (security_invoker = true) as
with corte as (
  select nullif(valor,'')::date as d from public.cmd_config where chave = 'data_corte_planilha'
)
select 'PLANILHA'::text as origem, s.cliente_id, s.codprod, s.qtd as qtd, s.vlrunit,
       (select d from corte) as data, null::bigint as nunota, null::bigint as numnota, null::integer as codtipoper
from public.cmd_saldo_inicial s
union all
select n.tipo, n.cliente_id, i.codprod,
       case when n.tipo = 'REMESSA' then i.qtd else -i.qtd end,
       i.vlrunit, n.dtneg, n.nunota, n.numnota, n.codtipoper
from public.cmd_notas n
join public.cmd_notas_itens i on i.nunota = n.nunota
where n.statusnota = 'L'
  and n.cliente_id is not null
  and n.dtneg > coalesce((select d from corte), date '1900-01-01');

create view public.cmd_v_saldo with (security_invoker = true) as
select m.cliente_id, c.nome as cliente, c.codparc, c.ativo,
       m.codprod, coalesce(p.descricao, 'PRODUTO ' || m.codprod) as produto,
       sum(m.qtd) as saldo,
       max(m.vlrunit) filter (where m.qtd > 0) as vlr_unit_ref,
       max(m.data) as ultima_movimentacao
from public.cmd_v_movimentos m
join public.cmd_clientes c on c.id = m.cliente_id
left join public.cmd_produtos p on p.codprod = m.codprod
group by m.cliente_id, c.nome, c.codparc, c.ativo, m.codprod, p.descricao;

create view public.cmd_v_retornos_pendentes with (security_invoker = true) as
select n.nunota, n.numnota, n.codtipoper, n.dtneg, n.codparc, n.observacao, n.statusnota,
       (select jsonb_agg(jsonb_build_object('codprod', i.codprod, 'produto', p.descricao, 'qtd', i.qtd) order by i.sequencia)
          from public.cmd_notas_itens i left join public.cmd_produtos p on p.codprod = i.codprod
         where i.nunota = n.nunota) as itens
from public.cmd_notas n
where n.cliente_id is null;

-- Seguranca: leitura apenas para usuarios logados; escrita so pela funcao de sync (service role) ou RPC.
alter table public.cmd_config enable row level security;
alter table public.cmd_clientes enable row level security;
alter table public.cmd_produtos enable row level security;
alter table public.cmd_notas enable row level security;
alter table public.cmd_notas_itens enable row level security;
alter table public.cmd_saldo_inicial enable row level security;
alter table public.cmd_sync_log enable row level security;

create policy cmd_config_ler on public.cmd_config for select to authenticated using (true);
create policy cmd_clientes_ler on public.cmd_clientes for select to authenticated using (true);
create policy cmd_produtos_ler on public.cmd_produtos for select to authenticated using (true);
create policy cmd_notas_ler on public.cmd_notas for select to authenticated using (true);
create policy cmd_notas_itens_ler on public.cmd_notas_itens for select to authenticated using (true);
create policy cmd_saldo_inicial_ler on public.cmd_saldo_inicial for select to authenticated using (true);
create policy cmd_sync_log_ler on public.cmd_sync_log for select to authenticated using (true);

-- Vincular retorno emitido para a Pannemix a um cliente (usado pela tela).
create function public.cmd_vincular_retorno(p_nunota bigint, p_cliente_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'login necessario';
  end if;
  update public.cmd_notas
     set cliente_id = p_cliente_id, vinculo_manual = true, vinculado_por = auth.uid(), vinculado_em = now()
   where nunota = p_nunota and tipo = 'RETORNO';
  if not found then
    raise exception 'nota de retorno % nao encontrada', p_nunota;
  end if;
end;
$$;
revoke all on function public.cmd_vincular_retorno(bigint, bigint) from public, anon;
grant execute on function public.cmd_vincular_retorno(bigint, bigint) to authenticated;
