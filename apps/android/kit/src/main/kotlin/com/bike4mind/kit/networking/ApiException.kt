package com.bike4mind.kit.networking

import com.bike4mind.client.infrastructure.HttpResponse

/** A non-2xx answer from a generated call. 401 and 426 never get here: the transport handles them first. */
class ApiException(val status: Int) : Exception("The server answered HTTP $status")

suspend fun <T> HttpResponse<T>.requireBody(): T {
    if (!success) throw ApiException(status)
    return body()
}
