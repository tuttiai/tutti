package sample

interface Repository {
    fun findAll(): List<String>
}

data class User(val name: String)

sealed class Result

object Registry

enum class Colour { RED }

typealias Names = List<String>

class UserRepository : Repository {
    override fun findAll(): List<String> = loadNames()
}

suspend fun loadNames(): List<String> = listOf()

fun <T> List<T>.secondOrNull(): T? = getOrNull(1)
