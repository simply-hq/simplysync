// Optional LAN advertisement so the mobile app can discover a relay running on
// the local network (e.g. a home NAS/Pi) without the user typing an IP. Off by
// default; enable with MDNS_ENABLE=1. Public/VPS deploys should leave it off.
//
// Requires the relay to actually be reachable on the LAN: in Docker, mDNS
// multicast only escapes the container with host networking (see
// docker-compose.yml / docs/local-first/self-hosting.md).
package main

import (
	"log"
	"os"

	"github.com/grandcat/zeroconf"
)

// mDNS service type mobile clients browse for. Keep it aligned with each
// client's relay-discovery implementation and iOS NSBonjourServices plist.
const mdnsService = "_simplysync._tcp"

func mdnsEnabled() bool {
	switch os.Getenv("MDNS_ENABLE") {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// startMDNS advertises this relay on the local network and returns a shutdown
// func. The TXT records tell clients the API base path and protocol version, so
// the discovered URL can be used as a transport directly.
func startMDNS(port int) (func(), error) {
	instance, err := os.Hostname()
	if err != nil || instance == "" {
		instance = "SimplySync Relay"
	}

	server, err := zeroconf.Register(
		instance,
		mdnsService,
		"local.",
		port,
		[]string{"path=/v1", "version=1"},
		nil, // advertise on all interfaces
	)
	if err != nil {
		return nil, err
	}

	log.Printf("mDNS: advertising %q as %s on port %d", instance, mdnsService, port)
	return server.Shutdown, nil
}
