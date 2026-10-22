package shipping

func trackingRoute() string {
	router := NewParcelRouter("tracking")
	return router.RouteParcel("tracking")
}
