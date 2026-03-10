#!/bin/bash
# Clean up database and migrations
cd /Users/aslezak/Documents/django_map

# Delete database
rm -f db.sqlite3

# Delete all migration files except __init__.py
find maps/migrations -name "*.py" ! -name "__init__.py" -delete
find maps/migrations -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null

# Also clean Python cache
rm -rf maps/__pycache__
rm -rf django_map/__pycache__

echo "✓ Cleaned database and migrations"
echo "✓ Removed Python cache"
