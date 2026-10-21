#!/bin/sh
# usage: ./run.sh file.js   (runs one suite against the evaluation copies with a hard time limit)
cd "$(dirname "$0")"
SUT_DIR=/Users/ochigaidoko/s7-eval/src SUT_OLD_DIR=/Users/ochigaidoko/s7-eval/old exec perl -e 'alarm 590; exec @ARGV' node "$@"
