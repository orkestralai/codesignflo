-- Which snapshot format a stored version uses (CANON_VERSION in @codesignflo/core). A version in another
-- format is not compared with Live (it would look different everywhere): it counts as not stored.
alter table public.generations add column canon_version int;
