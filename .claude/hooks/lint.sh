#!/usr/bin/env bash
set -euo pipefail

# Parse hook input
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# Exit early if no file path
[[ -z "$file_path" ]] && exit 0

# Only process TypeScript files
[[ "$file_path" =~ \.(ts|tsx)$ ]] || exit 0

# Throttle: only run every 10 seconds to avoid concurrency issues
state_dir=".claude/state"
throttle_file="$state_dir/.lint-last-run"
current_time=$(date +%s)

# Create state directory if it doesn't exist
mkdir -p "$state_dir"

# Check if we should throttle
if [[ -f "$throttle_file" ]]; then
	last_run=$(cat "$throttle_file")
	time_diff=$((current_time - last_run))

	# Exit early if less than 10 seconds have passed
	if [[ $time_diff -lt 10 ]]; then
		exit 0
	fi
fi

# Update timestamp
echo "$current_time" > "$throttle_file"

# Run eslint_d with --fix silently
eslint_output=$(eslint_d --cache --config ./eslint.config.ts --fix "$file_path" 2>&1 || true)

# Check if ESLint found unfixable errors
if echo "$eslint_output" | grep -qi "error"; then
	# Extract only error lines (first 5)
	errors=$(echo "$eslint_output" | grep -i "error" | head -5)

	# Output minimal JSON context for Claude
	jq -n \
		--arg errors "$errors" \
		--arg filepath "$file_path" \
		'{
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: ("⚠️ Lint errors in " + $filepath + ":\n" + $errors)
			}
		}'
	exit 0
fi

# Silent success - everything was auto-fixed
exit 0