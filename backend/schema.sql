-- Registro de Tesis — tablas, RLS y datos de ejemplo
-- Supabase → SQL Editor → Run
-- Authentication → Providers → Email: desactiva "Confirm email" en el prototipo.
-- La primera cuenta que se registre queda como admin.

create extension if not exists pgcrypto;

-- ---------- tablas ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  nombre text,
  rol text not null default 'usuario' check (rol in ('admin', 'usuario')),
  created_at timestamptz not null default now()
);

create table if not exists public.alumnos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  matricula text,
  sexo text,
  tipo text,
  fecha_reg date,
  created_at timestamptz not null default now()
);

create table if not exists public.docentes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  empleado integer,
  telefono text,
  correo text,
  sexo text,
  grado text,
  fecha_reg date,
  created_at timestamptz not null default now()
);

create table if not exists public.tesis (
  id uuid primary key default gen_random_uuid(),
  alumno_id uuid references public.alumnos (id) on delete set null,
  alumno_nombre text not null,
  grado text not null,
  titulo text not null,
  fecha date,
  ciudad text,
  programa text,
  punto text,
  capturo text,
  archivo text,
  digital text,
  fecha_cap date,
  obs text,
  created_at timestamptz not null default now()
);

create table if not exists public.tesis_docentes (
  id uuid primary key default gen_random_uuid(),
  tesis_id uuid not null references public.tesis (id) on delete cascade,
  docente_id uuid references public.docentes (id) on delete set null,
  docente_nombre text not null,
  fungio text not null,
  fecha date,
  folio integer not null unique
);

create table if not exists public.tesis_documentos (
  id uuid primary key default gen_random_uuid(),
  tesis_id uuid not null references public.tesis (id) on delete cascade,
  tipo text,
  nombre text,
  size bigint,
  fecha date,
  url text,
  storage_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.emitidos (
  id uuid primary key default gen_random_uuid(),
  fecha date,
  tipo text,
  dest text,
  docente text,
  detalle text,
  created_at timestamptz not null default now()
);

create sequence if not exists public.folio_seq;

-- ---------- funciones ----------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and rol = 'admin'
  );
$$;

create or replace function public.next_folio()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Solo un administrador puede asignar folios';
  end if;
  return nextval('public.folio_seq');
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  select count(*) into n from public.profiles;
  insert into public.profiles (id, email, nombre, rol)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1)),
    case when n = 0 then 'admin' else 'usuario' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

grant execute on function public.is_admin() to authenticated;
grant execute on function public.next_folio() to authenticated;

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.alumnos enable row level security;
alter table public.docentes enable row level security;
alter table public.tesis enable row level security;
alter table public.tesis_docentes enable row level security;
alter table public.tesis_documentos enable row level security;
alter table public.emitidos enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists alumnos_select on public.alumnos;
create policy alumnos_select on public.alumnos
  for select to authenticated using (true);
drop policy if exists alumnos_write on public.alumnos;
create policy alumnos_write on public.alumnos
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists docentes_select on public.docentes;
create policy docentes_select on public.docentes
  for select to authenticated using (true);
drop policy if exists docentes_write on public.docentes;
create policy docentes_write on public.docentes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists tesis_select on public.tesis;
create policy tesis_select on public.tesis
  for select to authenticated using (true);
drop policy if exists tesis_write on public.tesis;
create policy tesis_write on public.tesis
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists tesis_docentes_select on public.tesis_docentes;
create policy tesis_docentes_select on public.tesis_docentes
  for select to authenticated using (true);
drop policy if exists tesis_docentes_write on public.tesis_docentes;
create policy tesis_docentes_write on public.tesis_docentes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists tesis_documentos_select on public.tesis_documentos;
create policy tesis_documentos_select on public.tesis_documentos
  for select to authenticated using (true);
drop policy if exists tesis_documentos_write on public.tesis_documentos;
create policy tesis_documentos_write on public.tesis_documentos
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists emitidos_select on public.emitidos;
create policy emitidos_select on public.emitidos
  for select to authenticated using (true);
drop policy if exists emitidos_insert on public.emitidos;
create policy emitidos_insert on public.emitidos
  for insert to authenticated with check (true);
drop policy if exists emitidos_admin on public.emitidos;
create policy emitidos_admin on public.emitidos
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
drop policy if exists emitidos_delete on public.emitidos;
create policy emitidos_delete on public.emitidos
  for delete to authenticated
  using (public.is_admin());

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.alumnos, public.docentes, public.tesis, public.tesis_docentes, public.tesis_documentos, public.emitidos to authenticated;
grant usage, select on sequence public.folio_seq to authenticated;

-- ---------- storage ----------
insert into storage.buckets (id, name, public)
values ('documentos', 'documentos', true)
on conflict (id) do nothing;

drop policy if exists documentos_read on storage.objects;
create policy documentos_read on storage.objects
  for select to authenticated
  using (bucket_id = 'documentos');

drop policy if exists documentos_insert on storage.objects;
create policy documentos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documentos' and public.is_admin());

drop policy if exists documentos_delete on storage.objects;
create policy documentos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'documentos' and public.is_admin());

-- ---------- semilla (mismo contenido del prototipo) ----------
insert into public.alumnos (nombre, matricula, sexo, tipo, fecha_reg)
select v.nombre, v.matricula, v.sexo, v.tipo, v.fecha_reg::date
from (values
  ('Aizpuru Rubio Efraín Alberto', '302199', 'M', 'Individual', '2026-01-15'),
  ('Montes Sánchez Endira Elizet', '301844', 'F', 'Individual', '2026-01-15'),
  ('Cárdenas Bejarano Alejandra Ivett', '301220', 'F', 'Individual', '2026-01-15'),
  ('Dively Marisol Valenzuela Franco', '300987', 'F', 'Curso Opción Tesis', '2026-01-15'),
  ('Loya Martínez Josefina Isabel', '302410', 'F', 'Curso Opción Grado', '2026-01-15'),
  ('González Palacios Edgar Omar', '302273', 'M', 'Individual', '2026-01-15')
) as v(nombre, matricula, sexo, tipo, fecha_reg)
where not exists (select 1 from public.alumnos);

insert into public.docentes (nombre, empleado, telefono, correo, sexo, grado, fecha_reg)
select v.nombre, v.empleado::int, v.telefono, v.correo, v.sexo, v.grado, v.fecha_reg::date
from (values
  ('AGUIRRE AVILÉS JOSÉ EDMUNDO, DR.', 91008, '614 220 23 07', 'jaguir@uach.mx', 'M', 'Doctorado', '2025-08-01'),
  ('AGUIRRE RODRÍGUEZ JAÍME, DR.', 83432, '614 216 65 73', 'jaguirrer@uach.mx', 'M', 'Doctorado', '2025-08-01'),
  ('ALARCÓN RUBIO SAIRA KARINA, DRA.', 17583, '', '', 'F', 'Doctorado', '2025-08-01'),
  ('ALDRETE ENRÍQUEZ JOSÉ FRANCISCO, DR.', 17792, '6141909311', '', 'M', 'Doctorado', '2025-08-01'),
  ('ÁLVAREZ LOYA LILIANA, M.A.R.H.', 90991, '6144876817', 'lalvarez@uach.mx', 'F', 'Maestría', '2025-08-01'),
  ('ÁLVAREZ TRENTI PABLO ALEJANDRO', 20860, '(614)3-69-66-00', 'palvarez@uach.mx', 'M', 'Licenciatura', '2025-08-01'),
  ('MARTÍNEZ CARO GLORIA ANTONIETA, DRA.', 18189, '', '', 'F', 'Doctorado', '2025-08-01'),
  ('RODRÍGUEZ QUINTANA ERIKA NANCY, M.A.R.H.', 91505, '', '', 'F', 'Maestría', '2025-08-01')
) as v(nombre, empleado, telefono, correo, sexo, grado, fecha_reg)
where not exists (select 1 from public.docentes);

do $$
declare
  t1 uuid;
  t2 uuid;
  t3 uuid;
begin
  if exists (select 1 from public.tesis) then
    return;
  end if;

  insert into public.tesis (alumno_id, alumno_nombre, grado, titulo, fecha, ciudad, programa, punto, capturo, archivo, digital, fecha_cap, obs, created_at)
  values (
    (select id from public.alumnos where nombre = 'Aizpuru Rubio Efraín Alberto'),
    'Aizpuru Rubio Efraín Alberto', 'Maestría',
    'Estrategias para atraer, retener y desarrollar talento en Roca Taller',
    '2026-01-01', 'CHIHUAHUA', 'Individual', '3.3.1 TESIS DIRIGIDAS Y CONCLUIDAS',
    'Luis Carlos Higuera', 'SI', 'NO', '2026-02-03', '', '2026-01-01T00:00:01Z'
  ) returning id into t1;

  insert into public.tesis (alumno_id, alumno_nombre, grado, titulo, fecha, ciudad, programa, punto, capturo, archivo, digital, fecha_cap, obs, created_at)
  values (
    (select id from public.alumnos where nombre = 'Montes Sánchez Endira Elizet'),
    'Montes Sánchez Endira Elizet', 'Licenciatura',
    'Clima organizacional en una PyME del sector servicios',
    '2025-06-10', 'CHIHUAHUA', 'Individual', '3.3.1 TESIS DIRIGIDAS Y CONCLUIDAS',
    'Luis Carlos Higuera', 'SI', 'SI', '2025-06-20', '', '2026-01-01T00:00:02Z'
  ) returning id into t2;

  insert into public.tesis (alumno_id, alumno_nombre, grado, titulo, fecha, ciudad, programa, punto, capturo, archivo, digital, fecha_cap, obs, created_at)
  values (
    (select id from public.alumnos where nombre = 'Cárdenas Bejarano Alejandra Ivett'),
    'Cárdenas Bejarano Alejandra Ivett', 'Maestría',
    'Rotación de personal y compromiso laboral en el sector maquilador',
    '2025-11-20', 'CHIHUAHUA', 'Individual', '3.3.1 TESIS DIRIGIDAS Y CONCLUIDAS',
    'Luis Carlos Higuera', 'SI', 'NO', '2025-12-02', '', '2026-01-01T00:00:03Z'
  ) returning id into t3;

  insert into public.tesis_docentes (tesis_id, docente_id, docente_nombre, fungio, fecha, folio) values
    (t1, (select id from public.docentes where nombre = 'MARTÍNEZ CARO GLORIA ANTONIETA, DRA.'), 'MARTÍNEZ CARO GLORIA ANTONIETA, DRA.', 'DIRECTOR(A)', '2026-01-01', 1838),
    (t1, (select id from public.docentes where nombre = 'RODRÍGUEZ QUINTANA ERIKA NANCY, M.A.R.H.'), 'RODRÍGUEZ QUINTANA ERIKA NANCY, M.A.R.H.', 'ASESOR(A)/REVISOR(A)', '2026-01-01', 1867),
    (t2, (select id from public.docentes where nombre = 'MARTÍNEZ CARO GLORIA ANTONIETA, DRA.'), 'MARTÍNEZ CARO GLORIA ANTONIETA, DRA.', 'DIRECTOR(A)', '2025-06-10', 1868),
    (t2, (select id from public.docentes where nombre = 'AGUIRRE AVILÉS JOSÉ EDMUNDO, DR.'), 'AGUIRRE AVILÉS JOSÉ EDMUNDO, DR.', 'ASESOR(A)/REVISOR(A)', '2025-06-10', 1869),
    (t2, (select id from public.docentes where nombre = 'RODRÍGUEZ QUINTANA ERIKA NANCY, M.A.R.H.'), 'RODRÍGUEZ QUINTANA ERIKA NANCY, M.A.R.H.', 'ASESOR(A)/REVISOR(A)', '2025-06-10', 1870),
    (t3, (select id from public.docentes where nombre = 'MARTÍNEZ CARO GLORIA ANTONIETA, DRA.'), 'MARTÍNEZ CARO GLORIA ANTONIETA, DRA.', 'DIRECTOR(A)', '2025-11-20', 1871),
    (t3, (select id from public.docentes where nombre = 'ÁLVAREZ LOYA LILIANA, M.A.R.H.'), 'ÁLVAREZ LOYA LILIANA, M.A.R.H.', 'ASESOR(A)/REVISOR(A)', '2025-11-20', 1872),
    (t3, (select id from public.docentes where nombre = 'AGUIRRE RODRÍGUEZ JAÍME, DR.'), 'AGUIRRE RODRÍGUEZ JAÍME, DR.', 'ASESOR(A)/REVISOR(A)', '2025-11-20', 1873),
    (t3, (select id from public.docentes where nombre = 'RODRÍGUEZ QUINTANA ERIKA NANCY, M.A.R.H.'), 'RODRÍGUEZ QUINTANA ERIKA NANCY, M.A.R.H.', 'ASESOR(A)/REVISOR(A)', '2025-11-20', 1874);
end $$;

select setval(
  'public.folio_seq',
  greatest(1874, coalesce((select max(folio) from public.tesis_docentes), 1874)),
  true
);

-- Si ya existe una cuenta y quieres hacerla admin:
-- update public.profiles set rol = 'admin' where email = 'tu-correo@uach.mx';
