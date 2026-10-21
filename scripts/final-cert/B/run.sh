#!/bin/sh
# usage: ./run.sh <test-file>   (smoke-run settings used while developing)
cd "$(dirname "$0")"
SUT_DIR=${SUT_DIR:-/Users/ochigaidoko/s7-eval/src} SUT_OLD_DIR=${SUT_OLD_DIR:-/Users/ochigaidoko/s7-eval/old} exec node "$@"
