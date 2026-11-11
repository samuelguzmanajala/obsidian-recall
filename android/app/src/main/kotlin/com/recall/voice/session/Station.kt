package com.recall.voice.session

import com.recall.voice.api.Rating

/** Where a passed card's review stands with the server. */
enum class StationStatus { Pending, Confirmed, Rejected }

/** One station already passed in the session line. */
data class Station(val rating: Rating, val status: StationStatus)
