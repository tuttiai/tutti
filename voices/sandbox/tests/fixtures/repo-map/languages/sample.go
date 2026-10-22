package sample

type Store struct {
	items []string
}

type Reader interface {
	Read() string
}

type Label string

func NewStore() *Store {
	return &Store{}
}

func (s *Store) Read() string {
	return s.items[0]
}
