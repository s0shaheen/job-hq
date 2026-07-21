import { Button } from "@/components/ui/button";

/** Plain form post — sign-out must work with JavaScript disabled or broken. */
export default function SignOut() {
  return (
    <form action="/auth/signout" method="post">
      <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
        Sign out
      </Button>
    </form>
  );
}
