<?php

interface Notifier {}

trait Loggable {}

enum Status {
    case Active;
}

class Mailer implements Notifier {
    public function send($to) {
        return format_address($to);
    }
}

function format_address($to) {
    return $to;
}
