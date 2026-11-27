-- The service's own server (service_role) calls these: the oldest plugin that may apply Live updates (/api/plugin),
-- the launch places left (checkout) and who to email about a new plugin (the daily cron). Granted explicitly: new
-- functions are closed by default, and production didn't give the service role execute on them by itself (the
-- plugin route said "no minimum" while signed-out callers got 0.5.9). Safe to run again.
grant execute on function public.plugin_minimum() to service_role;
grant execute on function public.launch_spots() to service_role;
grant execute on function public.plugin_update_recipients(text, int) to service_role;
grant execute on function public.version_below(text, text) to service_role;

-- What the grants are now (shown when run in the SQL editor).
select has_function_privilege('service_role', 'public.plugin_minimum()', 'execute') as plugin_minimum,
       has_function_privilege('service_role', 'public.launch_spots()', 'execute') as launch_spots,
       has_function_privilege('service_role', 'public.plugin_update_recipients(text, int)', 'execute') as plugin_update_recipients;
