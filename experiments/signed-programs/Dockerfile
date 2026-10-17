# This image runs VM tests only. It contains no live signer or runtime state.
ARG BUILD_IMAGE=golang:1.26.9
FROM ${BUILD_IMAGE}
WORKDIR /signed-program-research
ADD --checksum=sha256:6b0daef7a5e3d68ea5fa681c5422ce9aa7c212d4a9c7ec6100ac9dccf4c9ad7c https://codeload.github.com/arkade-os/emulator/tar.gz/fb1992c7d5ba2068753ca7aebffd7110674cfbd8 /tmp/signed-program-emulator.tar.gz
RUN tar -xzf /tmp/signed-program-emulator.tar.gz --strip-components=1
COPY vm.patch /tmp/signed-program-vm.patch
RUN git apply /tmp/signed-program-vm.patch
COPY evalverify.go evalverify_test.go ./pkg/arkade/
COPY vector.json ./pkg/arkade/testdata/striker_signed_program.json
WORKDIR /signed-program-research/pkg/arkade
RUN go test ./... -count=1
CMD ["go", "test", "./...", "-count=1"]
