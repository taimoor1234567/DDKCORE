echo $(node -v)
# needs defined DB_HOST in environment
# and wait-port npm package installed
wait-port "$DB_HOST:${DB_PORT:-5432}"
sleep 5
    if [ "$MODE" == "TEST" ]; then
        npm run test
    fi
    if [ "$SERVICE" == "API" ]; then
        npm run start:api
    fi
    if [ "$SERVICE" == "CORE" ]; then
        npm run start:core
fi