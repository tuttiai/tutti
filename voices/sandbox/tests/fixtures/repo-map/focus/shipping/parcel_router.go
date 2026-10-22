package shipping

type ParcelRouter struct {
	Zone string
}

func NewParcelRouter(zone string) *ParcelRouter {
	return &ParcelRouter{Zone: zone}
}

func (r *ParcelRouter) RouteParcel(id string) string {
	return r.Zone + id
}
