#!/bin/bash

# Dynamic port selection based on Linear issue ID
# Extracts numeric ID from LINEAR_ISSUE_IDENTIFIER (e.g., PACK-293 -> 293)
ID=$(echo "$LINEAR_ISSUE_IDENTIFIER" | grep -oE '[0-9]+')
BASE=30100
SLOT=$((ID % 100))
KITTU_SERVER_PORT=$((BASE + SLOT))

# Export the dynamically selected port
export KITTU_SERVER_PORT=$KITTU_SERVER_PORT

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    touch .env
fi

# Add or update the port in .env file
if grep -q "^KITTU_SERVER_PORT=" .env; then
    # Update existing port
    sed -i.bak "s/^KITTU_SERVER_PORT=.*/KITTU_SERVER_PORT=$KITTU_SERVER_PORT/" .env
    rm .env.bak 2>/dev/null
else
    # Add new port
    echo "KITTU_SERVER_PORT=$KITTU_SERVER_PORT" >> .env
fi

cp /Users/kittuops/code/kittu/CLAUDE.local.md CLAUDE.local.md
