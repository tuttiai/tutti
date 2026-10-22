package shipping

func depotRoute() string {
	router := NewParcelRouter("depot")
	return router.RouteParcel("depot")
}
