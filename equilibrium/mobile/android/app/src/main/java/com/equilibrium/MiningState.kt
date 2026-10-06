package com.equilibrium

/**
 * What the foreground miner is actually doing. The UI reads this.
 * It is not a chain tip and it is not Ω.
 */
object MiningState {
    @Volatile var mining: String = "stopped"
    @Volatile var solver: String = "idle"
    @Volatile var searches: Long = 0
    @Volatile var solutions: Long = 0
    @Volatile var lastSolution: String = "—"
    @Volatile var lastSubmission: String = "—"
    @Volatile var httpHeight: String = "—"
    @Volatile var httpTipSource: String = "—"
    @Volatile var note: String = ""
}
