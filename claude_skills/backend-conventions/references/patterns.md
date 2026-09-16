# Backend patterns (copy-paste)

The scaffolded `items` routes in `backend/app.py` are the canonical example. To add
a new resource, follow the same shape.

## A read route (list)

```python
@app.route('/api/things', methods=['GET'])
def list_things():
    try:
        _ensure_schema()
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT * FROM things ORDER BY created_at DESC')
        rows = cur.fetchall()          # list of dicts (RealDictCursor)
        cur.close()
        conn.close()
        return jsonify(rows), 200
    except Exception as e:
        logger.error(f"List things error: {str(e)}")
        return jsonify({'error': 'Failed to list things'}), 500
```

## A write route (create)

```python
@app.route('/api/things', methods=['POST'])
def create_thing():
    try:
        _ensure_schema()
        data = request.get_json()
        if not data or not data.get('name'):
            return jsonify({'error': 'Name is required'}), 400
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'INSERT INTO things (name, payload) VALUES (%s, %s) RETURNING id',
            (data.get('name'), json.dumps(data.get('payload', {}))),
        )
        new_id = cur.fetchone()['id']
        conn.commit()
        cur.close()
        conn.close()
        return jsonify({'id': str(new_id), 'message': 'Thing created'}), 201
    except Exception as e:
        logger.error(f"Create thing error: {str(e)}")
        return jsonify({'error': 'Failed to create thing'}), 500
```

## Update / delete
- `UPDATE things SET ... WHERE id = %s RETURNING id`; if `cur.fetchone()` is `None`,
  the row didn't exist → `404`.
- `DELETE FROM things WHERE id = %s RETURNING id`; same `None` → `404` check.

## Checklist for any new endpoint
- [ ] `/api/...` path, method(s) explicit.
- [ ] `_ensure_schema()` if it touches a table added after `sql_init.sql`.
- [ ] Parameterised SQL.
- [ ] `conn.commit()` on writes; `cur.close()` + `conn.close()` always.
- [ ] `try/except` with `logger.error` + generic 500.
- [ ] New env var? Added to `os.getenv`, `.env.example`, and compose `environment:`.
- [ ] If the app has auth: `@token_required` + `AND user_id = %s` scoping.
