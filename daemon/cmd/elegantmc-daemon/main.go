package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"elegantmc/daemon/internal/commands"
	"elegantmc/daemon/internal/config"
	"elegantmc/daemon/internal/frp"
	"elegantmc/daemon/internal/mc"
	"elegantmc/daemon/internal/sandbox"
	"elegantmc/daemon/internal/wsclient"
)

func main() {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	logger := log.New(os.Stdout, "daemon: ", log.LstdFlags|log.Lmicroseconds)

	rootFS, err := sandbox.NewFS(cfg.ServersRoot())
	if err != nil {
		log.Fatalf("sandbox: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// FRP manager (child process supervisor).
	frpMgr := frp.NewManager(frp.ManagerConfig{
		FRPCPath: cfg.FRPCPath,
		WorkDir:  cfg.FRPWorkDir,
		Log:      logger,
	})

	// Minecraft process manager (local runner for now).
	mcMgr := mc.NewManager(mc.ManagerConfig{
		ServersFS: rootFS,
		Log:       logger,
		JavaCandidates: cfg.JavaCandidates,
	})

	exec := commands.NewExecutor(commands.ExecutorDeps{
		Log:    logger,
		FS:     rootFS,
		FRP:    frpMgr,
		MC:     mcMgr,
		Daemon: cfg.DaemonID,
		FRPC:   cfg.FRPCPath,
		PreferredConnectAddrs: cfg.PreferredConnectAddrs,
		Mojang: commands.MojangConfig{
			MetaBaseURL: cfg.MojangMetaBaseURL,
			DataBaseURL: cfg.MojangDataBaseURL,
		},
		Paper: commands.PaperConfig{
			APIBaseURL: cfg.PaperAPIBaseURL,
		},
	})

	client := wsclient.New(wsclient.Config{
		URL:             cfg.PanelWSURL,
		Token:           cfg.Token,
		DaemonID:        cfg.DaemonID,
		HeartbeatEvery:  time.Duration(cfg.HeartbeatSec) * time.Second,
		ReconnectMin:    1 * time.Second,
		ReconnectMax:    30 * time.Second,
		Log:             logger,
		CommandExecutor: exec,
	})

	if err := client.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Fatalf("ws client exited: %v", err)
	}
}
