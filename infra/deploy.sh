#!/bin/bash

# Fail on error
set -e

# Run from the /infra folder.

############################################################
# Help                                                     #
############################################################
Help() {
  # Display Help
  echo "Script used to provision/update the infrastructure for the FHIR server."
  echo "Run from the /infra folder."
  echo
  echo "Syntax: ./deploy.sh [-h] -e ENV [-s STACK] [-d]"
  echo "options:"
  echo "h     Print this Help."
  echo "e     The environment to which to deploy to. Must be one of production|sandbox|staging"
  echo "s     Stack to deploy: fhir (default), validate, or all"
  echo "d     Indicates to issue a CDK 'diff' command instead of 'deploy'."
  echo
  echo "Example: ./deploy.sh -e staging -s validate"
  echo
}

############################################################
# Deploy                                                   #
############################################################
Deploy() {
  npm run build
  npm run test
  if [[ "$diff" == "true" ]]; then
    cmd="diff"
  else
    cmd="deploy"
  fi
  local stacks
  case "$stack" in
  fhir) stacks="FHIRServerStack" ;;
  validate) stacks="FhirValidateServerStack" ;;
  all) stacks="FHIRServerStack FhirValidateServerStack" ;;
  *)
    echo "Invalid stack! -s must be one of fhir|validate|all"
    exit 1
    ;;
  esac
  echo "$cmd'ing to env $env stack(s): $stacks"
  npx cdk bootstrap -c env=$env
  npx cdk $cmd -c env=$env $stacks
  echo "Done!"
}

############################################################
# Main program                                             #
############################################################

stack="fhir"

# Get the options
while getopts ":he:s:d" option; do
  case $option in
  h) # display Help
    Help
    exit
    ;;
  e) # the environment to deploy to
    env=$OPTARG ;;
  s) # which stack to deploy
    stack=$OPTARG ;;
  d) # run a diff instead of deploy
    diff=true ;;
  \?) # Invalid option
    echo "Error: Invalid option"
    exit
    ;;
  esac
done

if [[ "$env" =~ ^production|sandbox|staging$ ]]; then
  Deploy
else
  echo "Invalid environment! -e must be one of production|sandbox|staging"
fi
