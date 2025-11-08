BUY ME A COFFEE? <3 BTC: 3Jzaw4EwSsPS1oQcZUXffNSkfcWobi6E4y

# bitburner-Suite
This master.js script for Bitburner is essentially a full-featured automation and management hub for your hacking empire, with a GUI overlay. Here’s a structured breakdown of what it does:

⸻

1. Core Purpose

It automates almost every major aspect of the game for you:
	•	Scans and roots servers automatically.
	•	Deploys and manages helper scripts (hack.js, grow.js, weaken.js, batcher.js) across your network.
	•	Automates money-making via optimized hacking.
	•	Manages purchased servers and Hacknet nodes.
	•	Optionally manages corporations if available.
	•	Provides a live Sci-Fi themed GUI for monitoring and controlling everything.

⸻

2. GUI (Graphical Interface)
	•	Displays stats:
	•	Money on hand
	•	Estimated $ per second
	•	Active workers
	•	Purchased servers and RAM
	•	Graph of money history with trend indicators (BULLISH, BEARISH, NEUTRAL).
	•	Network map of rooted servers.
	•	Debug overlay with logs and errors.
	•	Buttons to control:
	•	Start/pause automation
	•	Deploy scripts
	•	Upgrade servers
	•	Kill helpers (locally or network-wide)
	•	Start/stop worker batchers
	•	Boost hacking/grow/weaken modes
	•	Dump debug info
	•	Fully draggable and minimally customizable.

⸻

3. Server & Worker Management
	•	Scan all servers recursively from home.
	•	Auto-rooting: Attempts to nuke servers using available hacking programs.
	•	Worker selection:
	•	Uses home + purchased servers + rooted servers with sufficient RAM.
	•	Deploys helper scripts to all workers automatically.
	•	Purchased server manager:
	•	Buys new servers if within budget and below max limit.
	•	Upgrades or replaces weak servers based on configuration.
	•	Hacknet manager:
	•	Purchases nodes if affordable.
	•	Upgrades node level, RAM, or cores based on ROI heuristics.
	•	Batching system:
	•	Calculates optimal number of hack/grow/weaken threads based on target money fraction.
	•	Automatically launches batch scripts (batcher.js) on worker servers.
	•	Scales down batch size if RAM is insufficient.
	•	Boost modes: Temporarily increases hack/grow/weaken intensity for short bursts.

⸻

4. Money Hacking Logic
	•	Calculates optimal thread counts for hack/grow/weaken cycles per target server.
	•	Ensures server security stays low (weaken threads scheduled appropriately).
	•	Adjusts batch sizes dynamically if worker RAM is insufficient.
	•	Tracks money earned over time to calculate money/sec and trends.

⸻

5. Automation Features
	•	Auto-purchases hacking programs if funds allow.
	•	Auto-roots servers continuously.
	•	Auto-manages purchased servers and Hacknet nodes.
	•	Optional corporation automation:
	•	Creates corp if not present
	•	Expands industry/division
	•	Opens offices and hires employees

⸻

6. Logging & Debug
	•	Keeps internal metrics: workers, RAM, purchased servers, running PIDs, errors.
	•	GUI debug overlay shows last 400 log entries.
	•	Debug Dump button prints metrics to terminal.
	•	Audio ping for button-triggered events.

⸻

7. Control Flow
	•	Main loop runs continuously:
	1.	Scan servers and root them.
	2.	Update workers and deploy scripts.
	3.	Handle any GUI-triggered actions (deploy, upgrade, kill, boost, debug).
	4.	Auto-manage purchased servers, Hacknet nodes, optional corp, and buy tools.
	5.	Launch batchers on targets for automated hacking.
	6.	Update GUI and metrics (money, trend, worker status).

⸻

8. Advanced Features
	•	Trend analysis of money growth.
	•	Conservative automation to avoid overspending (reserves cash).
	•	Integrates batcher.js to schedule complex hack/grow/weaken cycles automatically.
	•	GUI buttons don’t directly call ns.* methods; they just set flags—main loop executes them safely.

⸻

In short:
master.js is a complete, single-file automation and monitoring system that:
	•	Hack servers efficiently using batchers.
	•	Manage purchased servers & Hacknet intelligently.
	•	Keep track of money trends, worker activity, and errors.
	•	Provide a powerful, Sci-Fi-themed GUI to monitor and control everything in real time.

It basically turns Bitburner into a nearly self-managing empire, with minimal manual intervention.
