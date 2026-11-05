.PHONY: setup verify verify-app verify-ml gen-shared

setup:
	cd app && npm ci
	cd ml && uv sync

gen-shared:
	cd app && npm run gen:shared

verify-app:
	cd app && npm run verify

verify-ml:
	cd ml && uv run ruff format --check . && uv run ruff check . && uv run mypy arcsense_ml tests && uv run pytest --cov

verify: verify-ml verify-app
