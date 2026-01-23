package commands

import (
	"os"
	"path"
	"path/filepath"
	"strings"

	"elegantmc/daemon/internal/mc"
	"elegantmc/daemon/internal/protocol"
)

func (e *Executor) mcRequiredJava(cmd protocol.Command) protocol.CommandResult {
	instanceID, _ := asString(cmd.Args["instance_id"])
	jarPath, _ := asString(cmd.Args["jar_path"])
	if strings.TrimSpace(instanceID) == "" {
		return fail("instance_id is required")
	}
	if err := validateInstanceID(instanceID); err != nil {
		return fail(err.Error())
	}
	if e.deps.FS == nil {
		return fail("servers filesystem not configured")
	}

	jarPath = strings.ReplaceAll(strings.TrimSpace(jarPath), "\\", "/")
	jarPath = strings.TrimPrefix(jarPath, "/")
	jarClean := path.Clean(jarPath)
	if jarClean == "." || jarClean == "/" || jarClean == ".." || strings.HasPrefix(jarClean, "../") || strings.HasPrefix(jarClean, "/") {
		return fail("invalid jar_path")
	}
	if !strings.HasSuffix(strings.ToLower(jarClean), ".jar") {
		return fail("jar_path must end with .jar")
	}

	abs, err := e.deps.FS.Resolve(filepath.Join(instanceID, filepath.FromSlash(jarClean)))
	if err != nil {
		return fail(err.Error())
	}
	st, err := os.Stat(abs)
	if err != nil {
		return fail(err.Error())
	}
	if st.IsDir() {
		return fail("jar_path is a directory")
	}
	maj, err := mc.RequiredJavaMajorFromJar(abs)
	if err != nil {
		return fail(err.Error())
	}
	return ok(map[string]any{
		"instance_id":         instanceID,
		"jar_path":            jarClean,
		"required_java_major": maj,
	})
}
