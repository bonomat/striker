set positional-arguments

network := env("STRIKER_NETWORK", "regtest")
export STRIKER_NETWORK := network

emulator := env("STRIKER_EMULATOR", "hosted")
export STRIKER_EMULATOR := emulator

# Show the available commands.
default:
    @just --list

# Install dependencies.
install:
    npm ci

# Build all three executables and the shared protocol.
build:
    npm run build

# Generate local configuration and persistent maker/taker keys, without funding.
init network=network emulator=emulator: build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node --experimental-eventsource --import tsx scripts/local.ts init

# Fund wallets, issue a demo token and create liquidity on regtest or Mutinynet.
setup network=network emulator=emulator: install build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node --experimental-eventsource --import tsx scripts/local.ts setup

# Run Maker and Striker together; Ctrl-C shuts down both.
start network=network emulator=emulator: build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node --experimental-eventsource --import tsx scripts/local.ts start

# Run only the maker service using .maker/config.json and .maker/deposit.json.
maker network=network emulator=emulator: build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node --experimental-eventsource apps/maker/dist/cli.js serve

# Run only Striker using .striker/config.json.
striker network=network emulator=emulator: build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node apps/striker/dist/cli.js serve

# Request and execute a swap through Striker, using the persistent taker wallet.
taker amount="" network=network emulator=emulator: build
    STRIKER_NETWORK="$2" STRIKER_EMULATOR="$3" node --experimental-eventsource --import tsx scripts/local.ts trade "$1"

# Request a quote without funding or executing it.
quote amount="" network=network emulator=emulator: build
    STRIKER_NETWORK="$2" STRIKER_EMULATOR="$3" node --experimental-eventsource --import tsx scripts/local.ts quote "$1"

# Execute the most recently saved quote.
execute network=network emulator=emulator: build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node --experimental-eventsource apps/taker/dist/cli.js execute

# Show the most recent swap's status.
status network=network emulator=emulator: build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node --experimental-eventsource apps/taker/dist/cli.js status

# Show the persistent maker wallet's funding address.
maker-address network=network emulator=emulator: build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node --experimental-eventsource apps/maker/dist/cli.js address

# Show the persistent taker wallet's funding address.
taker-address network=network emulator=emulator: build
    STRIKER_NETWORK="$1" STRIKER_EMULATOR="$2" node --experimental-eventsource apps/taker/dist/cli.js address

regtest-start:
    node scripts/regtest.mjs start

regtest-stop:
    node scripts/regtest.mjs stop

# Type-check, run unit tests, and exercise real regtest settlement.
test:
    npm run check
    npm test
    STRIKER_NETWORK=regtest STRIKER_EMULATOR=hosted npm run test:e2e

# Run a local Emulator connected to the public Mutinynet Arkade server.
emulator-start: build
    node --experimental-eventsource --import tsx scripts/local.ts emulator-start

emulator-stop: build
    node --experimental-eventsource --import tsx scripts/local.ts emulator-stop

emulator-logs: build
    node --experimental-eventsource --import tsx scripts/local.ts emulator-logs
