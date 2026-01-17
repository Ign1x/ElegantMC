package commands

import (
	"encoding/json"
	"time"
)

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

func timeNowUnix() int64 { return time.Now().Unix() }

