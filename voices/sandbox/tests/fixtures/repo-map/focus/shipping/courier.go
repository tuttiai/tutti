package shipping

func courierRoute() string {
	router := NewParcelRouter("courier")
	return router.RouteParcel("courier")
}
