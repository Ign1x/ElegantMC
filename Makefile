.PHONY: panel-build daemon-test daemon-vet test lint fmt

panel-build:
	cd panel && npm run build

daemon-test:
	cd daemon && go test ./...

daemon-vet:
	cd daemon && go vet ./...

test: daemon-test

lint: daemon-vet

fmt:
	cd daemon && gofmt -w .
