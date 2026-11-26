CREATE TABLE "user_repository" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_repository" ADD CONSTRAINT "user_repository_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_repository_user_id_idx" ON "user_repository" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_repository_user_repo_uidx" ON "user_repository" USING btree ("user_id","repo_full_name");