class InvoiceLedger:
    def record_payment(self, amount):
        return amount


def open_ledger():
    return InvoiceLedger()
