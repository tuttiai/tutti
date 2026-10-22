import Foundation

public protocol Drawable {
    func draw() -> String
}

@MainActor
final class Canvas: Drawable {
    func draw() -> String {
        return renderScene()
    }

    class func shared() -> Canvas {
        return Canvas()
    }
}

struct Point {
    let x: Double
}

enum Direction {
    case north
}

actor Counter {}

typealias Handler = () -> Void

private func renderScene() -> String {
    return "scene"
}

extension Canvas {}
