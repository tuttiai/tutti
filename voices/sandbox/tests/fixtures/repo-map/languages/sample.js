class EventBus {
  emit(name) {
    return dispatchEvent(name);
  }
}

function dispatchEvent(name) {
  return name;
}

const createBus = () => new EventBus();

module.exports = { createBus };
