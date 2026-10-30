CREATE ROLE anvil_backend NOINHERIT;
GRANT USAGE ON SCHEMA public TO anvil_backend;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anvil_backend;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anvil_backend;
GRANT anvil_backend TO service_role;
