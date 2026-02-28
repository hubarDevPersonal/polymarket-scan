package config

import (
	"os"
	"strconv"
)

// Config holds all application configuration loaded from environment variables.
type Config struct {
	HTTPAddr       string
	EdgeMinRORPct  float64
	TitleSim       float64
	TimeWindowH    int
	PMChunk        int
	KalshiKeyID    string
	KalshiKeyPath  string
}

// Load reads configuration from environment variables with default values.
func Load() *Config {
	return &Config{
		HTTPAddr:       getEnv("HTTP_ADDR", ":8080"),
		EdgeMinRORPct:  getEnvFloat("EDGE_MIN_ROR_PCT", 3.0),
		TitleSim:       getEnvFloat("TITLE_SIM", 0.60),
		TimeWindowH:    getEnvInt("TIME_WINDOW_H", 168),
		PMChunk:        getEnvInt("PM_CHUNK", 400),
		KalshiKeyID:    getEnv("KALSHI_KEY_ID", ""),
		KalshiKeyPath:  getEnv("KALSHI_PRIVATE_KEY_PATH", ""),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvFloat(key string, defaultValue float64) float64 {
	if value := os.Getenv(key); value != "" {
		if f, err := strconv.ParseFloat(value, 64); err == nil {
			return f
		}
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}
