class Repository:
    def find_user(self, user_id):
        return load_record(user_id)


def load_record(record_id):
    return record_id
