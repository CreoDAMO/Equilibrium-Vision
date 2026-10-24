package com.equilibrium

/**
 * The chain the phone is working. HTTP work and submission both name it.
 * Peer gossip is not isolated by this value, so it is not a mining path.
 */
object MinerNetwork {
    const val KEY = "chain_network"
    const val TESTNET = "testnet"
    const val MAINNET = "mainnet"

    fun normalize(raw: String?): String = if (raw == MAINNET) MAINNET else TESTNET

    fun chainId(network: String): Int = if (normalize(network) == MAINNET) 1 else 2

    fun label(network: String): String = if (normalize(network) == MAINNET) "Mainnet" else "Testnet"

    fun lightUrl(origin: String, network: String): String =
        "${origin.trimEnd('/')}/api/light?network=${normalize(network)}"

    fun submitUrl(origin: String, network: String): String =
        "${origin.trimEnd('/')}/api/blocks/submit?network=${normalize(network)}"

    fun releaseUrl(origin: String): String =
        "${origin.trimEnd('/')}/api/miner/release"
}
