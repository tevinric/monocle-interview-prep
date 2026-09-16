-- Applied ONCE by the Postgres entrypoint on a fresh data volume.
-- Keep every statement idempotent and mirror new tables/columns into the
-- _SCHEMA_SQL block in backend/app.py (see the db-migrations skill).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Shared trigger to keep updated_at current on any table that has the column.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- =============================================================================
-- EXAMPLE TABLE: items  (replace with your own domain tables)
-- =============================================================================
CREATE TABLE IF NOT EXISTS items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS update_items_updated_at ON items;
CREATE TRIGGER update_items_updated_at
    BEFORE UPDATE ON items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at DESC);
