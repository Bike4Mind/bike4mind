#!/usr/bin/env npx ts-node -r tsconfig-paths/register

import { userService } from '@bike4mind/services';
import { connectDB, userRepository } from '@bike4mind/database';
import { input, password } from '@inquirer/prompts';
import { Resource } from 'sst';

type UserCreatorOptions = {
  email: string;
  username: string;
  password: string;
  isAdmin: boolean;
  dbUri: string;
  stage: string;
};

const createUser = userService.createUser;

class UserCreator {
  private options: UserCreatorOptions;

  constructor(options: Pick<UserCreatorOptions, 'dbUri' | 'stage'>) {
    if (options.dbUri === undefined) throw new Error('MONGODB_URI env variable is required');
    if (options.stage === undefined) console.warn('STAGE env variable is not set.');
    this.options = {
      email: '',
      username: '',
      password: '',
      isAdmin: true,
      ...options,
    };
  }

  private async promptForUserDetails() {
    this.options.email = await input({ message: 'Enter user email:' });
    this.options.username = await input({ message: 'Enter username:' });
    this.options.password = await password({ message: 'Enter user password:' });
    this.options.isAdmin =
      (await input({
        message: 'Is this user an admin? (Y/n)',
        default: 'Y',
      })) === 'Y';
  }

  public async run() {
    try {
      console.log('🔧 USER CREATOR DEBUG: Starting user creation process');
      console.log('🔧 USER CREATOR DEBUG: Database URI:', this.options.dbUri.replace('%STAGE%', this.options.stage));
      console.log('🔧 USER CREATOR DEBUG: Stage:', this.options.stage);

      await this.promptForUserDetails();

      console.log('🔧 USER CREATOR DEBUG: User details collected:', {
        email: this.options.email,
        username: this.options.username,
        isAdmin: this.options.isAdmin,
        hasPassword: !!this.options.password,
      });

      console.log('🔧 USER CREATOR DEBUG: Connecting to database...');
      await connectDB(this.options.dbUri.replace('%STAGE%', this.options.stage));
      console.log('🔧 USER CREATOR DEBUG: Database connected successfully');

      const tags = this.options.isAdmin ? ['Developer', 'Analyst'] : [];
      console.log('🔧 USER CREATOR DEBUG: Tags:', tags);

      console.log('🔧 USER CREATOR DEBUG: Calling createUser service...');
      const newUser = await createUser(
        {
          username: this.options.username,
          email: this.options.email,
          name: this.options.username,
          isAdmin: this.options.isAdmin,
          emailVerified: true,
          initialCredits: 10_000,
          record: {
            password: this.options.password,
            isAdmin: this.options.isAdmin,
            // Operator typed this password interactively - it's a real, usable credential.
            hasUsablePassword: !!this.options.password,
          },
          tags,
        },
        {
          db: {
            users: userRepository,
          },
        }
      );

      console.log(
        '🔧 USER CREATOR DEBUG: createUser service returned:',
        newUser
          ? {
              id: newUser.id,
              username: newUser.username,
              email: newUser.email,
              isAdmin: newUser.isAdmin,
            }
          : 'NULL'
      );

      if (newUser) {
        console.log('✅ User created successfully:', newUser.username);

        // Verify the user was actually saved to the database
        console.log('🔧 USER CREATOR DEBUG: Verifying user in database...');
        const savedUser = await userRepository.findByUsernameOrEmail(this.options.username, this.options.email);
        console.log(
          '🔧 USER CREATOR DEBUG: Database verification result:',
          savedUser
            ? {
                id: savedUser.id,
                username: savedUser.username,
                email: savedUser.email,
                isAdmin: savedUser.isAdmin,
              }
            : 'USER NOT FOUND IN DATABASE'
        );

        return 0;
      } else {
        console.error('❌ Failed to create user - createUser returned null');
        return 1;
      }
    } catch (error) {
      console.error('❌ Error creating user:', error);
      console.error('❌ Error details:', error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
}

new UserCreator({ dbUri: Resource.MONGODB_URI.value, stage: Resource.App.stage })
  .run()
  .then((exitCode: number) => process.exit(exitCode))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
