from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import logging
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 20MB max upload

# Open CORS in the minimal starter; tighten origins once auth/deployment is added.
CORS(app, resources={r"/api/*": {"origins": "*"}})


# =============================================================================
# DATABASE CONNECTION
# =============================================================================
def get_db_connection():
    return psycopg2.connect(
        host=os.getenv('@@PREFIX@@_DB_HOST', 'localhost'),
        port=os.getenv('@@PREFIX@@_DB_PORT', '5432'),
        database=os.getenv('@@PREFIX@@_DB_NAME'),
        user=os.getenv('@@PREFIX@@_DB_USER'),
        password=os.getenv('@@PREFIX@@_DB_PASSWORD'),
        cursor_factory=RealDictCursor,
    )


# =============================================================================
# SCHEMA MIGRATION (idempotent — keeps existing databases up to date)
# =============================================================================
# The Postgres entrypoint only applies database/sql_init.sql on a FRESH data
# volume. For already-running databases, mirror every new table/column here as
# idempotent DDL so it self-applies on first use. Keep this in sync with
# sql_init.sql. See the db-migrations skill.
_SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

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
"""

_schema_ready = False


def _ensure_schema():
    """Run the idempotent schema migration once per process."""
    global _schema_ready
    if _schema_ready:
        return
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(_SCHEMA_SQL)
        conn.commit()
        cur.close()
        conn.close()
        _schema_ready = True
    except Exception as e:
        # Retry on the next request if the DB wasn't ready yet (e.g. backend
        # started before Postgres finished initialising).
        logger.error(f"Schema migration failed (will retry): {str(e)}")


# =============================================================================
# HEALTH
# =============================================================================
@app.route('/api/health', methods=['GET'])
def health_check():
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT 1')
        cur.close()
        conn.close()
        return jsonify({'status': 'healthy', 'database': 'connected'}), 200
    except Exception as e:
        return jsonify({'status': 'unhealthy', 'error': str(e)}), 500


# =============================================================================
# EXAMPLE RESOURCE: items  (replace with your own domain)
# =============================================================================
@app.route('/api/items', methods=['GET'])
def list_items():
    try:
        _ensure_schema()
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT * FROM items ORDER BY created_at DESC')
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return jsonify(rows), 200
    except Exception as e:
        logger.error(f"List items error: {str(e)}")
        return jsonify({'error': 'Failed to list items'}), 500


@app.route('/api/items', methods=['POST'])
def create_item():
    try:
        _ensure_schema()
        data = request.get_json()
        if not data or not data.get('name'):
            return jsonify({'error': 'Name is required'}), 400
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'INSERT INTO items (name, description) VALUES (%s, %s) RETURNING id',
            (data.get('name'), data.get('description')),
        )
        new_id = cur.fetchone()['id']
        conn.commit()
        cur.close()
        conn.close()
        return jsonify({'id': str(new_id), 'message': 'Item created'}), 201
    except Exception as e:
        logger.error(f"Create item error: {str(e)}")
        return jsonify({'error': 'Failed to create item'}), 500


@app.route('/api/items/<item_id>', methods=['GET'])
def get_item(item_id):
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT * FROM items WHERE id = %s', (item_id,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        if not row:
            return jsonify({'error': 'Not found'}), 404
        return jsonify(row), 200
    except Exception as e:
        logger.error(f"Get item error: {str(e)}")
        return jsonify({'error': 'Failed to get item'}), 500


@app.route('/api/items/<item_id>', methods=['PUT'])
def update_item(item_id):
    try:
        data = request.get_json() or {}
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'UPDATE items SET name = %s, description = %s WHERE id = %s RETURNING id',
            (data.get('name'), data.get('description'), item_id),
        )
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        if not row:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'id': str(row['id']), 'message': 'Item updated'}), 200
    except Exception as e:
        logger.error(f"Update item error: {str(e)}")
        return jsonify({'error': 'Failed to update item'}), 500


@app.route('/api/items/<item_id>', methods=['DELETE'])
def delete_item(item_id):
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('DELETE FROM items WHERE id = %s RETURNING id', (item_id,))
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        if not row:
            return jsonify({'error': 'Not found'}), 404
        return jsonify({'message': 'Item deleted'}), 200
    except Exception as e:
        logger.error(f"Delete item error: {str(e)}")
        return jsonify({'error': 'Failed to delete item'}), 500


if __name__ == '__main__':
    app.run(
        host='0.0.0.0',
        port=5000,
        debug=os.getenv('@@PREFIX@@_FLASK_ENV', 'production') == 'development',
    )
