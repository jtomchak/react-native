package dev.spahost.prototype

internal class HostError(val code: String, message: String) : Exception(message)
