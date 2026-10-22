export function GreetingCard(props: { name: string }) {
  return <div>{formatGreeting(props.name)}</div>;
}

function formatGreeting(name: string): string {
  return "Hello " + name;
}
