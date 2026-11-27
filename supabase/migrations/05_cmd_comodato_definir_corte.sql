create function public.cmd_definir_data_corte(p_data date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'login necessario'; end if;
  update public.cmd_config set valor = p_data::text, atualizado_em = now() where chave = 'data_corte_planilha';
end $$;
revoke all on function public.cmd_definir_data_corte(date) from public, anon;
grant execute on function public.cmd_definir_data_corte(date) to authenticated;

revoke all on function public.cmd_sugerir_data_corte() from public, anon;
revoke all on table public.cmd_segredos from anon, authenticated;
