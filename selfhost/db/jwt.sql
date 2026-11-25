-- From Supabase's self-hosting setup (docker/volumes/db/jwt.sql): the sign-in tokens' lifetime, for the database.
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
