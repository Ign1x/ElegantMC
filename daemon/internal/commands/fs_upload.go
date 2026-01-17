package commands

import (
	"context"
	"strings"

	"elegantmc/daemon/internal/protocol"
)

func (e *Executor) fsUploadBegin(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	if e.uploads == nil {
		return fail("uploads not configured")
	}
	path, _ := asString(cmd.Args["path"])
	res, err := e.uploads.Begin(ctx, path)
	if err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{
		"upload_id": res.UploadID,
		"path":      res.Path,
	})
}

func (e *Executor) fsUploadChunk(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	if e.uploads == nil {
		return fail("uploads not configured")
	}
	uploadID, _ := asString(cmd.Args["upload_id"])
	b64, _ := asString(cmd.Args["b64"])
	if strings.TrimSpace(uploadID) == "" {
		return fail("upload_id is required")
	}
	if b64 == "" {
		return fail("b64 is required")
	}
	bytes, err := e.uploads.Chunk(ctx, uploadID, b64)
	if err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{
		"upload_id": uploadID,
		"bytes":     bytes,
	})
}

func (e *Executor) fsUploadCommit(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	if e.uploads == nil {
		return fail("uploads not configured")
	}
	uploadID, _ := asString(cmd.Args["upload_id"])
	expectedSHA256, _ := asString(cmd.Args["sha256"])
	if strings.TrimSpace(uploadID) == "" {
		return fail("upload_id is required")
	}
	res, err := e.uploads.Commit(ctx, uploadID, expectedSHA256)
	if err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{
		"path":   res.Path,
		"bytes":  res.Bytes,
		"sha256": res.SHA256,
	})
}

func (e *Executor) fsUploadAbort(ctx context.Context, cmd protocol.Command) protocol.CommandResult {
	if e.uploads == nil {
		return fail("uploads not configured")
	}
	uploadID, _ := asString(cmd.Args["upload_id"])
	if strings.TrimSpace(uploadID) == "" {
		return fail("upload_id is required")
	}
	if err := e.uploads.Abort(ctx, uploadID); err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{"aborted": true})
}

